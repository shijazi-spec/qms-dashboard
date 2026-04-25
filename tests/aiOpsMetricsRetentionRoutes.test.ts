/**
 * Route-layer integration tests for `GET /api/ai-ops/metrics-retention`
 * (Task #654 — pin the 400-contract for the retention audit query).
 *
 * The validation logic that gates `limit`, `offset`, `from`, `to` is
 * unit-tested at the helper layer in `tests/aiMetricsRetentionConfig.test.ts`
 * (clamping behaviour) and exercised end-to-end by
 * `tests/aiMetricsRetentionDashboard.spec.ts` (Playwright). What was missing
 * — and what this file adds — is a per-handler assertion that the route
 * itself returns 400 with the documented error body when an operator (or
 * a buggy client) sends bad query inputs, AND a positive-path assertion
 * that the response shape carries `audit_total` and `audit_max_limit`
 * the dashboard depends on. A future refactor that loosened the route's
 * validator (e.g. silently ignored a malformed `from=`) would now fail
 * here instead of shipping unnoticed.
 *
 * Coverage matrix (mirroring task §"Done looks like"):
 *   (a) valid paging round-trip                    → 200, audit_total / audit_max_limit / paging echoed
 *   (b) limit > AI_METRICS_RETENTION_AUDIT_MAX_LIMIT → 400 with bound mentioned in error
 *   (c) negative offset                            → 400 with "non-negative" in error
 *   (d) malformed `from` / `to` ISO-8601           → 400 with field name in error
 *   (e) from > to                                  → 400 with "from must be on or before to"
 *   (f) date-range filter narrows the returned `audit_total`
 *
 * Approach: the existing aiOps route harness uses the in-process
 * `buildHandler` + `makeContext` helpers (Hono-compatible fake context)
 * rather than spinning up a real HTTP server, so this file follows the
 * same pattern. To make the happy-path tests deterministic without a
 * live Postgres we stub `pg.Pool.prototype.query` BEFORE importing the
 * route module — same technique as `tests/aiMetricsRetentionConfig.test.ts`.
 *
 * Run:  npx tsx tests/aiOpsMetricsRetentionRoutes.test.ts
 */

import pg from "pg";

// ─────────────────────────────────────────────────────────────────────────────
// pg stubbing — must be in place BEFORE the dynamic imports that the route
// handler triggers when first invoked (`aiTelemetry`, `aiMetricsRetentionConfig`).
// ─────────────────────────────────────────────────────────────────────────────

interface StubAuditRow {
  id: number;
  changed_at: Date;
  changed_by: string;
  before_days: number | null;
  after_days: number | null;
  note: string | null;
}

let stubbedAuditRows: StubAuditRow[] = [];

function dateBoundsFromParams(params: ReadonlyArray<unknown>): {
  from: Date | null;
  to: Date | null;
} {
  // Both the count and page queries pass [from?, to?, ...] in that order
  // (the page query also appends [limit, offset]). We just walk the head
  // of the params list and consume any leading Date instances.
  const bounds: Date[] = [];
  for (const p of params) {
    if (p instanceof Date) bounds.push(p);
    else break;
  }
  return { from: bounds[0] ?? null, to: bounds[1] ?? null };
}

function filterAuditRows(params: ReadonlyArray<unknown>): StubAuditRow[] {
  const { from, to } = dateBoundsFromParams(params);
  return stubbedAuditRows.filter((r) => {
    if (from && r.changed_at.getTime() < from.getTime()) return false;
    if (to && r.changed_at.getTime() > to.getTime()) return false;
    return true;
  });
}

const originalQuery = pg.Pool.prototype.query;

(pg.Pool.prototype as unknown as { query: unknown }).query =
  async function stubQuery(
    this: pg.Pool,
    sql: unknown,
    params?: ReadonlyArray<unknown>,
  ): Promise<unknown> {
    if (typeof sql !== "string") {
      return (originalQuery as unknown as (...args: unknown[]) => unknown).apply(
        this,
        [sql, params],
      );
    }
    const empty = {
      command: "",
      rowCount: 0,
      oid: 0,
      fields: [],
      rows: [] as unknown[],
    };
    if (
      /^\s*CREATE TABLE/i.test(sql) ||
      /^\s*ALTER TABLE/i.test(sql) ||
      /^\s*CREATE INDEX/i.test(sql)
    ) {
      return empty;
    }
    if (/SELECT[\s\S]+FROM ai_metrics_retention_config/i.test(sql)) {
      // No override row exists in any of these tests — keep the GET happy
      // by returning an empty resultset (the route maps that to
      // `override_days: null`).
      return { ...empty, rows: [] };
    }
    if (/SELECT[\s\S]+FROM ai_metrics_retention_audit/i.test(sql)) {
      const filtered = filterAuditRows(params ?? []);
      if (/COUNT\(\*\)/i.test(sql)) {
        return { ...empty, rows: [{ n: filtered.length }] };
      }
      // Page query — the last two params are [limit, offset].
      const tail = (params ?? []) as unknown[];
      const limit = Number(tail[tail.length - 2] ?? 25);
      const offset = Number(tail[tail.length - 1] ?? 0);
      // Mirror the route's ORDER BY changed_at DESC, id DESC.
      const sorted = [...filtered].sort((a, b) => {
        const dt = b.changed_at.getTime() - a.changed_at.getTime();
        return dt !== 0 ? dt : b.id - a.id;
      });
      return { ...empty, rows: sorted.slice(offset, offset + limit) };
    }
    return empty;
  } as typeof pg.Pool.prototype.query;

// connect() is only used by the write path (PUT), but stub it to a noop
// so an accidental call doesn't try to hit a real DB.
(pg.Pool.prototype as unknown as { connect: unknown }).connect =
  async function stubConnect(this: pg.Pool): Promise<unknown> {
    return {
      query: async () => ({
        command: "",
        rowCount: 0,
        oid: 0,
        fields: [],
        rows: [],
      }),
      release: () => {},
    };
  } as typeof pg.Pool.prototype.connect;

// Now safe to import the route module — its sharedPool already inherits
// the stubbed prototype.
const { aiOpsRoutes } = await import("../src/mastra/routes/aiOpsRoutes");
const { TestSuite } = await import("./_helpers/runner");
const { buildHandler, makeContext } = await import("./_helpers/fakeContext");
const { AI_METRICS_RETENTION_AUDIT_MAX_LIMIT } = await import(
  "../src/utils/aiMetricsRetentionConfig"
);

const suite = new TestSuite("aiOpsMetricsRetentionRoutes");
const ADMIN_KEY = "integration-test-ai-ops-retention-2026";
const ROUTE_PATH = "/api/ai-ops/metrics-retention";
const ROUTE_METHOD = "GET";

console.log("\n=== aiOpsMetricsRetentionRoutes integration tests ===\n");

function withAdminKey<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  return fn().finally(() => {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  });
}

function resetAuditFixture(): void {
  // Six rows spanning a one-week window, newest first.
  // 2026-04-25 is "today" in this scenario — the dashboard spec uses the
  // same anchor so the bounds-checks line up.
  stubbedAuditRows = [
    { id: 6, changed_at: new Date("2026-04-25T12:00:00Z"), changed_by: "alice",   before_days: 30, after_days: 21, note: "today"     },
    { id: 5, changed_at: new Date("2026-04-24T10:00:00Z"), changed_by: "bob",     before_days: 45, after_days: 30, note: "yesterday" },
    { id: 4, changed_at: new Date("2026-04-22T08:00:00Z"), changed_by: "carol",   before_days: 60, after_days: 45, note: "midweek"   },
    { id: 3, changed_at: new Date("2026-04-20T08:00:00Z"), changed_by: "dave",    before_days: 90, after_days: 60, note: "earlier"   },
    { id: 2, changed_at: new Date("2026-04-18T08:00:00Z"), changed_by: "erin",    before_days: 120, after_days: 90, note: "older"    },
    { id: 1, changed_at: new Date("2026-04-15T08:00:00Z"), changed_by: "frank",   before_days: 180, after_days: 120, note: "oldest"  },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanity: confirm the route is wired into the registry.
// ─────────────────────────────────────────────────────────────────────────────
await suite.test("GET /api/ai-ops/metrics-retention is registered", () => {
  const paths = aiOpsRoutes.map((r) => `${r.method} ${r.path}`);
  suite.expect(
    paths.includes(`${ROUTE_METHOD} ${ROUTE_PATH}`),
    "metrics-retention GET route is wired",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) Valid paging round-trip.
//
// Pin the response shape that the dashboard depends on: every paged read
// must echo `audit_total` (so "Showing 1–N of M" can render), the page
// slice itself, the `audit_limit` / `audit_offset` / `audit_max_limit`
// hints, and the boundary echoes (`audit_from` / `audit_to`).
// ─────────────────────────────────────────────────────────────────────────────
await suite.test(
  "happy: valid limit + offset round-trips and exposes audit_total / audit_max_limit",
  async () => {
    resetAuditFixture();
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { limit: "2", offset: "2" },
        }),
      );
      suite.expectEqual(res.status, 200, "status");
      const data = res.body?.data;
      suite.expect(data && typeof data === "object", "body.data present");
      // Total reflects the full unfiltered set (6), not the page size.
      suite.expectEqual(data.audit_total, 6, "audit_total counts all rows");
      suite.expectEqual(data.audit_limit, 2, "audit_limit echoed");
      suite.expectEqual(data.audit_offset, 2, "audit_offset echoed");
      suite.expectEqual(
        data.audit_max_limit,
        AI_METRICS_RETENTION_AUDIT_MAX_LIMIT,
        "audit_max_limit surfaces the server ceiling",
      );
      suite.expectEqual(data.audit_from, null, "audit_from is null when unset");
      suite.expectEqual(data.audit_to, null, "audit_to is null when unset");
      // Newest-first ordering, then offset 2 → ids 4 and 3.
      const ids = (data.audit ?? []).map((r: any) => r.id);
      suite.expectEqual(ids.length, 2, "page slice has 2 rows");
      suite.expectEqual(ids[0], 4, "first paged id is 4 (offset=2 in newest-first order)");
      suite.expectEqual(ids[1], 3, "second paged id is 3");
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// (b) limit over the 100 ceiling → 400.
// ─────────────────────────────────────────────────────────────────────────────
await suite.test(
  "400: limit above AI_METRICS_RETENTION_AUDIT_MAX_LIMIT is rejected",
  async () => {
    resetAuditFixture();
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { limit: String(AI_METRICS_RETENTION_AUDIT_MAX_LIMIT + 1) },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string" &&
          res.body.error.includes(String(AI_METRICS_RETENTION_AUDIT_MAX_LIMIT)),
        `error mentions the ceiling (${AI_METRICS_RETENTION_AUDIT_MAX_LIMIT}); got: ${res.body?.error}`,
      );
    });
  },
);

await suite.test(
  "400: limit=0 is rejected (lower bound is 1, not 0)",
  async () => {
    resetAuditFixture();
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { limit: "0" },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string" && res.body.error.toLowerCase().includes("limit"),
        `error mentions limit; got: ${res.body?.error}`,
      );
    });
  },
);

await suite.test(
  "400: non-integer limit (e.g. '12.5') is rejected",
  async () => {
    resetAuditFixture();
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { limit: "12.5" },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string" && res.body.error.toLowerCase().includes("limit"),
        `error mentions limit; got: ${res.body?.error}`,
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// (c) Negative offset → 400.
// ─────────────────────────────────────────────────────────────────────────────
await suite.test(
  "400: negative offset is rejected",
  async () => {
    resetAuditFixture();
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { offset: "-1" },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string" &&
          res.body.error.toLowerCase().includes("offset") &&
          res.body.error.toLowerCase().includes("non-negative"),
        `error mentions offset and non-negative; got: ${res.body?.error}`,
      );
    });
  },
);

await suite.test(
  "400: non-integer offset (e.g. '1.5') is rejected",
  async () => {
    resetAuditFixture();
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { offset: "1.5" },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string" && res.body.error.toLowerCase().includes("offset"),
        `error mentions offset; got: ${res.body?.error}`,
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// (d) Malformed `from` / `to` → 400.
// ─────────────────────────────────────────────────────────────────────────────
await suite.test(
  "400: malformed `from` ISO-8601 is rejected with field name in error",
  async () => {
    resetAuditFixture();
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { from: "not a real date at all" },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string" &&
          res.body.error.toLowerCase().includes("from") &&
          res.body.error.toLowerCase().includes("iso-8601"),
        `error mentions from + iso-8601; got: ${res.body?.error}`,
      );
    });
  },
);

await suite.test(
  "400: malformed `to` ISO-8601 is rejected with field name in error",
  async () => {
    resetAuditFixture();
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { to: "definitely not a timestamp" },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string" &&
          res.body.error.toLowerCase().includes("to") &&
          res.body.error.toLowerCase().includes("iso-8601"),
        `error mentions to + iso-8601; got: ${res.body?.error}`,
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// (e) `from > to` → 400.
// ─────────────────────────────────────────────────────────────────────────────
await suite.test(
  "400: from > to is rejected with descriptive message",
  async () => {
    resetAuditFixture();
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: {
            from: "2026-04-25T00:00:00Z",
            to: "2026-04-20T00:00:00Z",
          },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expectEqual(
        res.body?.error,
        "from must be on or before to",
        "error matches the documented contract",
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// (f) Date-range filter narrows the returned `audit_total`.
//
// First read the unfiltered total to establish the baseline (6), then
// constrain the window to [2026-04-21, 2026-04-25] which our fixture
// shrinks down to ids {6, 5, 4} → audit_total === 3. Asserting the
// *narrowed* total catches the failure mode where the route ignores the
// filter on either query (page or count).
// ─────────────────────────────────────────────────────────────────────────────
await suite.test(
  "happy: from/to filter narrows audit_total and the returned page",
  async () => {
    resetAuditFixture();
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);

      // Baseline: no filter → all 6 rows.
      const baseline = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { limit: "100" },
        }),
      );
      suite.expectEqual(baseline.status, 200, "baseline status");
      suite.expectEqual(baseline.body?.data?.audit_total, 6, "baseline total = 6");
      suite.expectEqual(
        (baseline.body?.data?.audit ?? []).length,
        6,
        "baseline returns all 6 rows",
      );

      // Filter to a 5-day window that excludes ids 1, 2, 3.
      const FROM = "2026-04-21T00:00:00Z";
      const TO = "2026-04-25T23:59:59Z";
      const filtered = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { limit: "100", from: FROM, to: TO },
        }),
      );
      suite.expectEqual(filtered.status, 200, "filtered status");
      suite.expectEqual(filtered.body?.data?.audit_total, 3, "filtered total = 3");
      suite.expectEqual(
        filtered.body?.data?.audit_from,
        new Date(FROM).toISOString(),
        "audit_from echoed as ISO-8601",
      );
      suite.expectEqual(
        filtered.body?.data?.audit_to,
        new Date(TO).toISOString(),
        "audit_to echoed as ISO-8601",
      );
      const filteredIds = (filtered.body?.data?.audit ?? []).map((r: any) => r.id);
      suite.expectEqual(filteredIds.length, 3, "filtered page has 3 rows");
      suite.expect(
        filteredIds.includes(6) && filteredIds.includes(5) && filteredIds.includes(4),
        `filtered page includes ids 6, 5, 4; got: ${filteredIds.join(",")}`,
      );
      suite.expect(
        !filteredIds.includes(3) && !filteredIds.includes(2) && !filteredIds.includes(1),
        `filtered page excludes ids 3, 2, 1; got: ${filteredIds.join(",")}`,
      );
    });
  },
);

suite.finishOrExit();
