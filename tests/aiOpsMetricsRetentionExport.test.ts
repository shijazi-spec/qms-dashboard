/**
 * Route-layer tests for `GET /api/ai-ops/metrics-retention/export.csv`
 * (Task #652 — CSV export of the retention audit history).
 *
 * Coverage:
 *   (a) happy path — full export returns CSV with header + every row,
 *       Content-Type / Content-Disposition / charset are correct, and
 *       the filename echoes the active filter window.
 *   (b) date-range filter narrows the exported rows to the matching set
 *       (proves the filter is honoured server-side end-to-end).
 *   (c) export bypasses the 100-row paging ceiling — a fixture larger
 *       than AI_METRICS_RETENTION_AUDIT_MAX_LIMIT round-trips entirely.
 *   (d) RFC 4180 quoting — notes containing commas, quotes, and
 *       embedded newlines round-trip with field count preserved.
 *   (e) `from > to` is rejected with the same 400 contract as the GET.
 *   (f) malformed ISO-8601 in `from` / `to` is rejected.
 *
 * Mirrors the pg-prototype stubbing approach used by
 * `tests/aiOpsMetricsRetentionRoutes.test.ts` so the suite stays
 * deterministic without a live Postgres.
 *
 * Run: npx tsx tests/aiOpsMetricsRetentionExport.test.ts
 */

import pg from "pg";

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
    if (/SELECT[\s\S]+FROM ai_metrics_retention_audit/i.test(sql)) {
      const filtered = filterAuditRows(params ?? []);
      const tail = (params ?? []) as unknown[];
      const limit = Number(tail[tail.length - 2] ?? 25);
      const offset = Number(tail[tail.length - 1] ?? 0);
      const sorted = [...filtered].sort((a, b) => {
        const dt = b.changed_at.getTime() - a.changed_at.getTime();
        return dt !== 0 ? dt : b.id - a.id;
      });
      return { ...empty, rows: sorted.slice(offset, offset + limit) };
    }
    return empty;
  } as typeof pg.Pool.prototype.query;

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

const { aiOpsRoutes } = await import("../src/mastra/routes/aiOpsRoutes");
const { TestSuite } = await import("./_helpers/runner");
const { buildHandler, makeContext } = await import("./_helpers/fakeContext");
const { makeCookieForRole } = await import("./_helpers/sessionAuth");
const {
  AI_METRICS_RETENTION_AUDIT_MAX_LIMIT,
  AI_METRICS_RETENTION_AUDIT_EXPORT_BATCH_SIZE,
} = await import("../src/utils/aiMetricsRetentionConfig");

const suite = new TestSuite("aiOpsMetricsRetentionExport");
const ADMIN_KEY = "integration-test-ai-ops-retention-export-2026";
// Signed walaplus_session cookie for an active admin platform user (requireRole()
// now always performs a live getPlatformUser() lookup — the shared helper also
// registers an active platform_users row for this session's email).
const ADMIN_COOKIE = makeCookieForRole("admin");
const ROUTE_PATH = "/api/ai-ops/metrics-retention/export.csv";
const ROUTE_METHOD = "GET";

console.log("\n=== aiOpsMetricsRetentionExport integration tests ===\n");

function withAdminKey<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  return fn().finally(() => {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  });
}

function resetAuditFixture(): void {
  stubbedAuditRows = [
    { id: 6, changed_at: new Date("2026-04-25T12:00:00Z"), changed_by: "alice",   before_days: 30, after_days: 21, note: "today"     },
    { id: 5, changed_at: new Date("2026-04-24T10:00:00Z"), changed_by: "bob",     before_days: 45, after_days: 30, note: "yesterday" },
    { id: 4, changed_at: new Date("2026-04-22T08:00:00Z"), changed_by: "carol",   before_days: 60, after_days: 45, note: "midweek"   },
    { id: 3, changed_at: new Date("2026-04-20T08:00:00Z"), changed_by: "dave",    before_days: 90, after_days: 60, note: "earlier"   },
    { id: 2, changed_at: new Date("2026-04-18T08:00:00Z"), changed_by: "erin",    before_days: 120, after_days: 90, note: "older"    },
    { id: 1, changed_at: new Date("2026-04-15T08:00:00Z"), changed_by: "frank",   before_days: 180, after_days: 120, note: "oldest"  },
  ];
}

// Parse a single RFC 4180 CSV record (handles quoted fields with embedded
// commas, doubled quotes, and embedded newlines). Used to assert the
// quoting contract end-to-end without pulling in a CSV dependency.
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      row.push(field);
      out.push(row);
      row = [];
      field = "";
      i += 2;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      out.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

await suite.test("export route is registered", () => {
  const paths = aiOpsRoutes.map((r) => `${r.method} ${r.path}`);
  suite.expect(
    paths.includes(`${ROUTE_METHOD} ${ROUTE_PATH}`),
    "metrics-retention export.csv route is wired",
  );
});

await suite.test(
  "happy: full export returns CSV with header + every row and correct headers",
  async () => {
    resetAuditFixture();
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { Cookie: ADMIN_COOKIE },
          query: {},
        }),
      );
      suite.expectEqual(res.status, 200, "status");
      const headers = res.headers ?? {};
      const ct = String(headers["Content-Type"] ?? headers["content-type"] ?? "");
      suite.expect(
        ct.includes("text/csv") && ct.toLowerCase().includes("charset=utf-8"),
        `Content-Type is text/csv with utf-8 charset; got: ${ct}`,
      );
      const cd = String(
        headers["Content-Disposition"] ?? headers["content-disposition"] ?? "",
      );
      suite.expect(
        cd.startsWith("attachment;") && /filename="ai-metrics-retention-audit_all_to_all_/.test(cd),
        `Content-Disposition is attachment with all_to_all filename; got: ${cd}`,
      );
      const body = String(res.body ?? "");
      const rows = parseCsv(body);
      suite.expectEqual(rows[0]?.[0], "timestamp", "first column header");
      suite.expectEqual(rows[0]?.[4], "note", "last column header");
      // 6 fixture rows + 1 header. The trailing newline produces a
      // single empty trailing row in the parser output, so allow either.
      const dataRowCount = rows.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== "")).length;
      suite.expectEqual(dataRowCount, 6, "all 6 fixture rows present");
      // Newest-first ordering: top data row should be id=6 (alice).
      suite.expectEqual(rows[1]?.[1], "alice", "first row operator is alice (newest)");
      suite.expectEqual(rows[1]?.[2], "30", "before_days for alice = 30");
      suite.expectEqual(rows[1]?.[3], "21", "after_days for alice = 21");
    });
  },
);

await suite.test(
  "filter: from/to narrows the exported rows and filename encodes the window",
  async () => {
    resetAuditFixture();
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const FROM = "2026-04-21T00:00:00Z";
      const TO = "2026-04-25T23:59:59Z";
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { Cookie: ADMIN_COOKIE },
          query: { from: FROM, to: TO },
        }),
      );
      suite.expectEqual(res.status, 200, "status");
      const headers = res.headers ?? {};
      const cd = String(
        headers["Content-Disposition"] ?? headers["content-disposition"] ?? "",
      );
      suite.expect(
        cd.includes("ai-metrics-retention-audit_2026-04-21_to_2026-04-25_"),
        `filename includes the date window; got: ${cd}`,
      );
      const rows = parseCsv(String(res.body ?? ""));
      const dataRowCount = rows.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== "")).length;
      suite.expectEqual(dataRowCount, 3, "filter narrows to 3 rows");
      const operators = rows.slice(1, 4).map((r) => r[1]);
      suite.expect(
        operators.includes("alice") && operators.includes("bob") && operators.includes("carol"),
        `filtered operators are alice/bob/carol; got: ${operators.join(",")}`,
      );
    });
  },
);

await suite.test(
  "export bypasses the 100-row paging ceiling",
  async () => {
    // Build a fixture larger than the paged-GET ceiling. This proves the
    // export endpoint genuinely streams past AI_METRICS_RETENTION_AUDIT_MAX_LIMIT
    // rather than silently capping at the page size.
    const HOW_MANY = AI_METRICS_RETENTION_AUDIT_MAX_LIMIT + 25;
    stubbedAuditRows = [];
    const baseMs = new Date("2025-01-01T00:00:00Z").getTime();
    for (let i = 1; i <= HOW_MANY; i++) {
      stubbedAuditRows.push({
        id: i,
        changed_at: new Date(baseMs + i * 60_000),
        changed_by: `op${i}`,
        before_days: 30,
        after_days: 21,
        note: `change ${i}`,
      });
    }
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { Cookie: ADMIN_COOKIE },
          query: {},
        }),
      );
      suite.expectEqual(res.status, 200, "status");
      const rows = parseCsv(String(res.body ?? ""));
      const dataRowCount = rows.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== "")).length;
      suite.expectEqual(
        dataRowCount,
        HOW_MANY,
        `all ${HOW_MANY} rows exported (above the ${AI_METRICS_RETENTION_AUDIT_MAX_LIMIT} paging ceiling)`,
      );
      // Sanity: the export iterates in batches; if the batch boundary
      // were buggy we'd see a duplicate or a gap. Asserting a unique
      // operator at the row-after-the-first-batch boundary catches
      // both modes.
      const boundaryOpExpected = `op${HOW_MANY - AI_METRICS_RETENTION_AUDIT_EXPORT_BATCH_SIZE}`;
      const allOps = new Set(rows.slice(1).map((r) => r[1]).filter(Boolean));
      suite.expect(
        allOps.size === HOW_MANY,
        `all operators unique; got ${allOps.size} of ${HOW_MANY}`,
      );
      suite.expect(
        // boundaryOpExpected may legitimately be missing if HOW_MANY <
        // batch size, but our fixture is sized to cross the boundary.
        HOW_MANY <= AI_METRICS_RETENTION_AUDIT_EXPORT_BATCH_SIZE
          ? true
          : allOps.has(boundaryOpExpected),
        `boundary operator ${boundaryOpExpected} is present`,
      );
    });
  },
);

await suite.test(
  "RFC 4180 quoting: notes with commas, quotes, and newlines round-trip",
  async () => {
    stubbedAuditRows = [
      {
        id: 1,
        changed_at: new Date("2026-04-25T12:00:00Z"),
        changed_by: "alice",
        before_days: 30,
        after_days: 21,
        note: 'INC-1234, tightened: "quick perf experiment"\nwith newline',
      },
    ];
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { Cookie: ADMIN_COOKIE },
          query: {},
        }),
      );
      suite.expectEqual(res.status, 200, "status");
      const rows = parseCsv(String(res.body ?? ""));
      // Header + 1 data row + (possibly) a trailing empty row.
      const data = rows.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
      suite.expectEqual(data.length, 1, "single row preserved despite embedded newline");
      suite.expectEqual(data[0]?.length, 5, "row still has 5 columns despite embedded comma");
      suite.expectEqual(
        data[0]?.[4],
        'INC-1234, tightened: "quick perf experiment"\nwith newline',
        "note round-trips losslessly",
      );
    });
  },
);

await suite.test(
  "400: from > to is rejected with the documented error",
  async () => {
    resetAuditFixture();
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { Cookie: ADMIN_COOKIE },
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
        "error matches the GET endpoint contract",
      );
    });
  },
);

await suite.test(
  "400: malformed `from` is rejected",
  async () => {
    resetAuditFixture();
    await withAdminKey(async () => {
      const handler = await buildHandler(aiOpsRoutes, ROUTE_PATH, ROUTE_METHOD);
      const res = await handler(
        makeContext({
          method: ROUTE_METHOD,
          headers: { Cookie: ADMIN_COOKIE },
          query: { from: "not a real date" },
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

suite.finishOrExit();
