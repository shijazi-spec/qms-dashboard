/**
 * Integration tests for all estimate endpoints across route modules.
 *
 * Coverage matrix:
 *   - 401 (auth boundary)  — every auth-gated estimate endpoint returns 401
 *                            when called without credentials.  Auth check fires
 *                            before any DB query, so these run without DATABASE_URL.
 *   - 200 (happy path)     — every estimate endpoint returns the correct JSON
 *                            body shape { rows, bytes, format } and the
 *                            X-Estimated-Rows / X-Estimated-Bytes / X-Export-Format
 *                            headers that streaming-download.js relies on.
 *                            Gated on DATABASE_URL.
 *   - filter params        — at least one filtered call per endpoint that uses
 *                            WHERE filters (event logs, policies, duplicates) to
 *                            confirm the query doesn't blow up with params.
 *
 * Relevant routes covered:
 *   /api/risks/export/estimate              (riskRoutes)
 *   /api/risks/export-xlsx/estimate         (riskRoutes)
 *   /api/logs/export/estimate               (eventLogsRoutes)
 *   /api/policies/export/estimate           (policyRoutes)
 *   /api/duplicates/export/estimate         (duplicateRadarRoutes)
 *   /api/duplicates/export-xlsx/estimate    (duplicateRadarRoutes)
 *   /api/qms/nc/export/estimate             (qmsEnhancedRoutes)
 *   /api/qms/capa/export/estimate           (qmsEnhancedRoutes)
 *   /api/compliance/export/estimate         (qmsEnhancedRoutes)
 *   /api/pdpl/export/estimate               (qmsEnhancedRoutes)
 *   /api/kpis/export/estimate               (qmsEnhancedRoutes)
 *   /api/kpis/export-xlsx/estimate          (qmsEnhancedRoutes)
 *   /api/vendors/export/estimate            (qmsEnhancedRoutes)
 *   /api/vendors/export-xlsx/estimate       (qmsEnhancedRoutes)
 *   /api/qms/nc/export-xlsx/estimate        (qmsEnhancedRoutes)
 *   /api/qms/capa-export-xlsx/estimate      (qmsEnhancedRoutes)
 *
 * Run:  npx tsx tests/estimateEndpoints.test.ts
 */

import { riskRoutes } from "../src/mastra/routes/riskRoutes";
import { qmsEnhancedRoutes } from "../src/mastra/routes/qmsEnhancedRoutes";
import { duplicateRadarRoutes } from "../src/mastra/routes/duplicateRadarRoutes";
import { policyRoutes } from "../src/mastra/routes/policyRoutes";
import { eventLogsRoutes } from "../src/mastra/routes/eventLogsRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("estimateEndpoints");
const HAS_DB = !!process.env.DATABASE_URL;
const ADMIN_KEY = "integration-test-estimate-2026";

console.log("\n=== estimate endpoint integration tests ===\n");

// ---------------------------------------------------------------------------
// Response-shape normaliser
// ---------------------------------------------------------------------------

/**
 * Estimate route handlers return a native `Response` from `estimateResponse()`
 * on the happy path, but auth-rejection helpers return a `CapturedResponse`
 * (plain object) from `c.json()`.  This function normalises both so test
 * assertions can use the same field names regardless of which branch fired.
 */
async function resolveResponse(result: any): Promise<{
  status: number;
  body: any;
  responseHeaders: Record<string, string>;
}> {
  if (result instanceof Response) {
    const body = await result.json().catch(() => null);
    const responseHeaders: Record<string, string> = {};
    result.headers.forEach((v: string, k: string) => {
      responseHeaders[k] = v;
    });
    return { status: result.status, body, responseHeaders };
  }
  return {
    status: result.status ?? 200,
    body: result.body,
    responseHeaders: result.headers ?? {},
  };
}

/** Make a context that carries a valid admin key in the request header. */
function withAdminKey(extra: Parameters<typeof makeContext>[0] = {}): ReturnType<typeof makeContext> {
  return makeContext({
    ...extra,
    headers: { "X-Admin-Key": ADMIN_KEY, ...(extra.headers ?? {}) },
  });
}

/** Save / restore ADMIN_API_KEY around a test callback. */
async function withKey(fn: () => Promise<void>): Promise<void> {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
}

// ---------------------------------------------------------------------------
// Shared assertion helper for the happy-path response shape
// ---------------------------------------------------------------------------

function assertEstimateShape(
  res: { status: number; body: any; responseHeaders: Record<string, string> },
  label: string,
  expectedFormat: "csv" | "xlsx",
): void {
  suite.expectEqual(res.status, 200, `${label}: status`);
  suite.expect(res.body !== null && typeof res.body === "object", `${label}: body is object`);
  suite.expect(typeof res.body?.rows === "number", `${label}: body.rows is number`);
  suite.expect(typeof res.body?.bytes === "number", `${label}: body.bytes is number`);
  suite.expectEqual(res.body?.format, expectedFormat, `${label}: body.format`);
  suite.expect(res.body?.rows >= 0, `${label}: body.rows >= 0`);
  suite.expect(res.body?.bytes >= 0, `${label}: body.bytes >= 0`);

  // Headers are returned lower-cased by the native fetch Headers API but
  // upper-cased by our fakeContext — accept both.
  const hKeys = Object.keys(res.responseHeaders).map((k) => k.toLowerCase());
  suite.expect(hKeys.includes("x-estimated-rows"), `${label}: X-Estimated-Rows header present`);
  suite.expect(hKeys.includes("x-estimated-bytes"), `${label}: X-Estimated-Bytes header present`);
  suite.expect(hKeys.includes("x-export-format"), `${label}: X-Export-Format header present`);

  const rowsHdr =
    res.responseHeaders["X-Estimated-Rows"] ?? res.responseHeaders["x-estimated-rows"] ?? "";
  const bytesHdr =
    res.responseHeaders["X-Estimated-Bytes"] ?? res.responseHeaders["x-estimated-bytes"] ?? "";
  suite.expect(/^\d+$/.test(rowsHdr), `${label}: X-Estimated-Rows is numeric string`);
  suite.expect(/^\d+$/.test(bytesHdr), `${label}: X-Estimated-Bytes is numeric string`);
}

// ---------------------------------------------------------------------------
// Auth-boundary tests (no DATABASE_URL required)
// ---------------------------------------------------------------------------

const AUTH_GATED: Array<{
  label: string;
  routes: any[];
  path: string;
}> = [
  { label: "risks CSV",        routes: riskRoutes,           path: "/api/risks/export/estimate" },
  { label: "risks XLSX",       routes: riskRoutes,           path: "/api/risks/export-xlsx/estimate" },
  { label: "event logs CSV",   routes: eventLogsRoutes,      path: "/api/logs/export/estimate" },
  { label: "policies CSV",     routes: policyRoutes,         path: "/api/policies/export/estimate" },
  { label: "duplicates CSV",   routes: duplicateRadarRoutes, path: "/api/duplicates/export/estimate" },
  { label: "duplicates XLSX",  routes: duplicateRadarRoutes, path: "/api/duplicates/export-xlsx/estimate" },
  // qmsEnhancedRoutes are wrapped in gateApiRoute — all /api/* paths require auth
  { label: "QMS NC CSV",       routes: qmsEnhancedRoutes,    path: "/api/qms/nc/export/estimate" },
  { label: "QMS CAPA CSV",     routes: qmsEnhancedRoutes,    path: "/api/qms/capa/export/estimate" },
  { label: "compliance CSV",   routes: qmsEnhancedRoutes,    path: "/api/compliance/export/estimate" },
  { label: "PDPL CSV",         routes: qmsEnhancedRoutes,    path: "/api/pdpl/export/estimate" },
  { label: "KPIs CSV",         routes: qmsEnhancedRoutes,    path: "/api/kpis/export/estimate" },
  { label: "KPIs XLSX",        routes: qmsEnhancedRoutes,    path: "/api/kpis/export-xlsx/estimate" },
  { label: "vendors CSV",      routes: qmsEnhancedRoutes,    path: "/api/vendors/export/estimate" },
  { label: "vendors XLSX",     routes: qmsEnhancedRoutes,    path: "/api/vendors/export-xlsx/estimate" },
  { label: "QMS NC XLSX",      routes: qmsEnhancedRoutes,    path: "/api/qms/nc/export-xlsx/estimate" },
  { label: "QMS CAPA XLSX",    routes: qmsEnhancedRoutes,    path: "/api/qms/capa-export-xlsx/estimate" },
];

for (const { label, routes, path } of AUTH_GATED) {
  await suite.test(`GET ${path} — 401 without auth (${label})`, async () => {
    await withKey(async () => {
      const handler = await buildHandler(routes, path, "GET");
      const raw = await handler(
        makeContext({ method: "GET", url: `http://localhost:5000${path}` }),
      );
      const res = await resolveResponse(raw);
      suite.expectEqual(res.status, 401, `${label}: status without auth`);
      suite.expect(typeof res.body?.error === "string", `${label}: body.error is string`);
    });
  });
}

// ---------------------------------------------------------------------------
// Happy-path tests — require DATABASE_URL
// ---------------------------------------------------------------------------

if (HAS_DB) {
  // --- riskRoutes ---

  await suite.test("GET /api/risks/export/estimate — 200 shape (DB)", async () => {
    await withKey(async () => {
      const handler = await buildHandler(riskRoutes, "/api/risks/export/estimate", "GET");
      const raw = await handler(withAdminKey({ method: "GET" }));
      assertEstimateShape(await resolveResponse(raw), "risks CSV", "csv");
    });
  });

  await suite.test("GET /api/risks/export-xlsx/estimate — 200 shape (DB)", async () => {
    await withKey(async () => {
      const handler = await buildHandler(riskRoutes, "/api/risks/export-xlsx/estimate", "GET");
      const raw = await handler(withAdminKey({ method: "GET" }));
      assertEstimateShape(await resolveResponse(raw), "risks XLSX", "xlsx");
    });
  });

  // --- eventLogsRoutes ---

  await suite.test("GET /api/logs/export/estimate — 200 shape (DB)", async () => {
    await withKey(async () => {
      const handler = await buildHandler(eventLogsRoutes, "/api/logs/export/estimate", "GET");
      const raw = await handler(withAdminKey({ method: "GET" }));
      assertEstimateShape(await resolveResponse(raw), "event logs CSV", "csv");
    });
  });

  await suite.test("GET /api/logs/export/estimate — honours severity filter (DB)", async () => {
    await withKey(async () => {
      const handler = await buildHandler(eventLogsRoutes, "/api/logs/export/estimate", "GET");
      const raw = await handler(
        withAdminKey({ method: "GET", query: { severity: "critical" } }),
      );
      const res = await resolveResponse(raw);
      suite.expectEqual(res.status, 200, "logs filtered: status");
      suite.expect(typeof res.body?.rows === "number", "logs filtered: body.rows is number");
      suite.expect(res.body?.rows >= 0, "logs filtered: body.rows >= 0");
    });
  });

  await suite.test("GET /api/logs/export/estimate — honours actionType filter (DB)", async () => {
    await withKey(async () => {
      const handler = await buildHandler(eventLogsRoutes, "/api/logs/export/estimate", "GET");
      const raw = await handler(
        withAdminKey({ method: "GET", query: { actionType: "LOGIN" } }),
      );
      const res = await resolveResponse(raw);
      suite.expectEqual(res.status, 200, "logs actionType filter: status");
      suite.expect(res.body?.rows >= 0, "logs actionType filter: body.rows >= 0");
    });
  });

  // --- policyRoutes ---

  await suite.test("GET /api/policies/export/estimate — 200 shape (DB)", async () => {
    await withKey(async () => {
      const handler = await buildHandler(policyRoutes, "/api/policies/export/estimate", "GET");
      // policyRoutes uses new URL(c.req.url) to parse filters
      const raw = await handler(
        withAdminKey({
          method: "GET",
          url: "http://localhost:5000/api/policies/export/estimate",
        }),
      );
      assertEstimateShape(await resolveResponse(raw), "policies CSV", "csv");
    });
  });

  await suite.test("GET /api/policies/export/estimate — honours status filter (DB)", async () => {
    await withKey(async () => {
      const handler = await buildHandler(policyRoutes, "/api/policies/export/estimate", "GET");
      const raw = await handler(
        withAdminKey({
          method: "GET",
          url: "http://localhost:5000/api/policies/export/estimate?status=active",
        }),
      );
      const res = await resolveResponse(raw);
      suite.expectEqual(res.status, 200, "policies status filter: status");
      suite.expect(res.body?.rows >= 0, "policies status filter: body.rows >= 0");
    });
  });

  // --- duplicateRadarRoutes ---

  await suite.test("GET /api/duplicates/export/estimate — 200 shape (DB)", async () => {
    await withKey(async () => {
      const handler = await buildHandler(
        duplicateRadarRoutes,
        "/api/duplicates/export/estimate",
        "GET",
      );
      const raw = await handler(
        withAdminKey({
          method: "GET",
          url: "http://localhost:5000/api/duplicates/export/estimate",
        }),
      );
      assertEstimateShape(await resolveResponse(raw), "duplicates CSV", "csv");
    });
  });

  await suite.test("GET /api/duplicates/export/estimate — honours date filters (DB)", async () => {
    await withKey(async () => {
      const handler = await buildHandler(
        duplicateRadarRoutes,
        "/api/duplicates/export/estimate",
        "GET",
      );
      const raw = await handler(
        withAdminKey({
          method: "GET",
          url: "http://localhost:5000/api/duplicates/export/estimate?start_date=2024-01-01&end_date=2025-12-31",
        }),
      );
      const res = await resolveResponse(raw);
      suite.expectEqual(res.status, 200, "duplicates date filter: status");
      suite.expect(res.body?.rows >= 0, "duplicates date filter: body.rows >= 0");
    });
  });

  await suite.test("GET /api/duplicates/export-xlsx/estimate — 200 shape (DB)", async () => {
    await withKey(async () => {
      const handler = await buildHandler(
        duplicateRadarRoutes,
        "/api/duplicates/export-xlsx/estimate",
        "GET",
      );
      const raw = await handler(
        withAdminKey({
          method: "GET",
          url: "http://localhost:5000/api/duplicates/export-xlsx/estimate",
        }),
      );
      assertEstimateShape(await resolveResponse(raw), "duplicates XLSX", "xlsx");
    });
  });

  await suite.test(
    "GET /api/duplicates/export-xlsx/estimate — include_raw=1 accepted without error (DB)",
    async () => {
      await withKey(async () => {
        const handler = await buildHandler(
          duplicateRadarRoutes,
          "/api/duplicates/export-xlsx/estimate",
          "GET",
        );
        const raw = await handler(
          withAdminKey({
            method: "GET",
            url: "http://localhost:5000/api/duplicates/export-xlsx/estimate?include_raw=1",
          }),
        );
        const res = await resolveResponse(raw);
        suite.expectEqual(res.status, 200, "duplicates XLSX include_raw: status");
        suite.expectEqual(res.body?.format, "xlsx", "duplicates XLSX include_raw: format");
      });
    },
  );

  // --- qmsEnhancedRoutes ---

  const QMS_HAPPY: Array<{ path: string; label: string; format: "csv" | "xlsx" }> = [
    { path: "/api/qms/nc/export/estimate",      label: "QMS NC CSV",    format: "csv" },
    { path: "/api/qms/capa/export/estimate",    label: "QMS CAPA CSV",  format: "csv" },
    { path: "/api/compliance/export/estimate",  label: "compliance CSV", format: "csv" },
    { path: "/api/pdpl/export/estimate",        label: "PDPL CSV",      format: "csv" },
    { path: "/api/kpis/export/estimate",        label: "KPIs CSV",      format: "csv" },
    { path: "/api/kpis/export-xlsx/estimate",   label: "KPIs XLSX",     format: "xlsx" },
    { path: "/api/vendors/export/estimate",     label: "vendors CSV",   format: "csv" },
    { path: "/api/vendors/export-xlsx/estimate", label: "vendors XLSX", format: "xlsx" },
    { path: "/api/qms/nc/export-xlsx/estimate",    label: "QMS NC XLSX",   format: "xlsx" },
    { path: "/api/qms/capa-export-xlsx/estimate",  label: "QMS CAPA XLSX", format: "xlsx" },
  ];

  for (const { path, label, format } of QMS_HAPPY) {
    await suite.test(`GET ${path} — 200 shape (DB, ${label})`, async () => {
      await withKey(async () => {
        const handler = await buildHandler(qmsEnhancedRoutes, path, "GET");
        const raw = await handler(withAdminKey({ method: "GET" }));
        assertEstimateShape(await resolveResponse(raw), label, format);
      });
    });
  }
} else {
  console.log(
    "  (skipped) happy-path estimate tests — DATABASE_URL not set\n" +
      "  Set DATABASE_URL to run the full suite.",
  );
}

suite.finishOrExit();
