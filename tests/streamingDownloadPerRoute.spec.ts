/**
 * WalaPlus streaming-download — per-route, client-observed latency budget
 * ───────────────────────────────────────────────────────────────────────
 *
 * Why this test exists
 * ────────────────────
 * Two existing checks measure parts of the streaming-export latency story:
 *
 *   1. tests/streamingExportLatency.integration.ts — issues a raw `fetch`
 *      from Node against every export route and asserts the
 *      `X-Stream-TTFB-Ms` server header is within budget. That covers the
 *      *server side* of TTFB only: the time from when the request reaches
 *      our Hono handler to when the first byte leaves our process.
 *
 *   2. tests/streamingDownload.spec.ts — drives the dashboard's
 *      `streamingDownload(url, …)` helper through a real browser, but
 *      against a single ~80-byte intercepted CSV fixture. It catches
 *      cross-engine regressions in the SW/transferable-stream pipeline,
 *      but cannot catch a per-route browser-side regression on a real
 *      backend response.
 *
 * Neither of those measures what an end user actually sees: TLS handshake,
 * edge/CDN buffering, service-worker streaming overhead, browser disk-write
 * throughput, the iframe round-trip the SW uses to start the download,
 * etc. A real-browser, per-route test is the only way to catch a
 * regression in any of those layers before users feel it.
 *
 * What this test does
 * ───────────────────
 * For every export endpoint already inventoried in
 * tests/streamingExportLatency.integration.ts, this spec:
 *
 *   • Loads a real, gated dashboard page (/vendors) so the live
 *     `dashboard/js/streaming-download.js` and the streaming SW are both
 *     in the page.
 *   • Forces the service-worker streaming path on every browser
 *     (deletes window.showSaveFilePicker so Chromium does not pop a
 *     native save dialog Playwright cannot dismiss; passes
 *     `streamToDisk: 'always'` so the in-memory Blob shortcut is also
 *     bypassed).
 *   • Calls the actual `window.streamingDownload(url, …)` helper for
 *     each route, with the admin auth header.
 *   • Captures TWO client-observed timings:
 *
 *        – CLIENT TTFB:  Performance Resource Timing
 *                       `responseStart - requestStart` for the export
 *                       fetch entry. This is exactly what the browser
 *                       measured between sending the request and
 *                       receiving the first byte of the body — i.e.
 *                       includes DNS, TCP, TLS, server processing, and
 *                       network latency. Distinct from the server-only
 *                       `X-Stream-TTFB-Ms` measured by integration test.
 *
 *        – CLIENT TOTAL: `performance.now()` measured around the entire
 *                       `streamingDownload(...)` promise, so it includes
 *                       the SW iframe round-trip, transferable
 *                       ReadableStream postMessage, last-byte time, and
 *                       any SW-side write throughput.
 *
 *   • Asserts both are within the same `EXPORT_TTFB_BUDGET_MS` /
 *     `EXPORT_TOTAL_BUDGET_MS` budgets the integration test enforces, so
 *     the two layers are kept in lock-step. A regression in either the
 *     server pipeline OR the browser-side streaming path now fails the
 *     same suite — which is the entire point of the task.
 *
 * Auth
 * ────
 * Mirrors tests/realExportEndpoint.spec.ts: POST `/api/admin/auth` with
 * `ADMIN_API_KEY` (or `TEST_ADMIN_KEY`) to set the session cookie, AND
 * forward the same key as `X-Admin-Key` on every export fetch (required
 * by routes whose `requireRole` helper only recognises the header form).
 *
 * Audit-XLSX route
 * ────────────────
 * `/api/audits/:id/export-xlsx` short-circuits with 404 on a missing
 * audit, which would skip `stageStreamingExportFromHono` entirely and
 * make the timing measurement meaningless. We seed a deterministic test
 * audit row exactly the same way the integration test does (direct pg
 * INSERT, `ON CONFLICT DO UPDATE`), and clean it up in `afterAll`. When
 * `DATABASE_URL` is not set we skip just that one route rather than the
 * whole suite, so local devs can still run the rest of the test without
 * a postgres handy.
 *
 * Run
 * ───
 *   ADMIN_API_KEY=… DATABASE_URL=… BASE_URL=http://localhost:5000 \
 *   npx playwright test tests/streamingDownloadPerRoute.spec.ts \
 *       --project=chromium --reporter=list
 *
 * Wired into runIntegrationTests.ts behind the same env gate as the
 * server-side latency check (`RUN_STREAMING_EXPORT_LATENCY_E2E=1`), so
 * the two layers run alongside each other and a regression in either
 * fails the same job (the task's acceptance criterion).
 */

import { test, expect, type BrowserContext } from '@playwright/test';
import pg from 'pg';

import {
  EXPORT_TTFB_BUDGET_MS,
  EXPORT_TOTAL_BUDGET_MS,
} from '../src/utils/excelExport.js';

const { Pool } = pg;

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const DATABASE_URL = process.env.DATABASE_URL;

// Deterministic audit row used exclusively by this spec. The
// `stream-pr-` prefix (distinct from the integration test's
// `stream-export-latency-`) keeps orphaned rows easy to spot if a run
// dies between setup and afterAll, AND prevents collisions when both
// suites run back-to-back against the same database.
const TEST_AUDIT_ID = 'stream-pr-test-audit-001';

interface ExportRoute {
  label: string;
  path: string;
  /**
   * If true, the route requires the seeded test audit row (only the
   * /api/audits/:id/export-xlsx route does today). When DATABASE_URL is
   * not provided we skip just these routes, not the whole spec, so the
   * test still adds value locally without a postgres handy.
   */
  requiresSeededAudit?: boolean;
}

// Mirrors tests/streamingExportLatency.integration.ts — keep the two
// lists in sync. The CSV/XLSX duality, the hyphenated CAPA-XLSX path
// (shadowed by /api/qms/capa/:id otherwise), and the audit-XLSX entry
// are all explained in detail in that file's comments; not repeated
// here to avoid drift if those rationales change.
const EXPORT_ROUTES: ExportRoute[] = [
  { label: 'vendors CSV',     path: '/api/vendors/export'        },
  { label: 'vendors XLSX',    path: '/api/vendors/export-xlsx'   },
  { label: 'QMS NC CSV',      path: '/api/qms/nc/export'         },
  { label: 'QMS NC XLSX',     path: '/api/qms/nc/export-xlsx'    },
  { label: 'QMS CAPA CSV',    path: '/api/qms/capa/export'       },
  { label: 'QMS CAPA XLSX',   path: '/api/qms/capa-export-xlsx'  },
  { label: 'compliance CSV',  path: '/api/compliance/export'     },
  { label: 'PDPL CSV',        path: '/api/pdpl/export'           },
  { label: 'KPIs CSV',        path: '/api/kpis/export'           },
  { label: 'KPIs XLSX',       path: '/api/kpis/export-xlsx'      },
  { label: 'risks CSV',       path: '/api/risks/export'          },
  { label: 'risks XLSX',      path: '/api/risks/export-xlsx'     },
  { label: 'duplicates CSV',  path: '/api/duplicates/export'     },
  { label: 'duplicates XLSX', path: '/api/duplicates/export-xlsx'},
  { label: 'policies CSV',    path: '/api/policies/export'       },
  { label: 'event logs CSV',  path: '/api/logs/export'           },
  {
    label: 'audit XLSX',
    path: `/api/audits/${TEST_AUDIT_ID}/export-xlsx`,
    requiresSeededAudit: true,
  },
];

function resolveAdminKey(): string | null {
  const key = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY;
  if (key) return key;
  if (process.env.CI === 'true') {
    throw new Error(
      'CI: ADMIN_API_KEY / TEST_ADMIN_KEY missing — refusing to skip the ' +
        'per-route streaming-download client-budget smoke test.',
    );
  }
  return null;
}

async function authenticateAdmin(
  context: BrowserContext,
  adminKey: string,
): Promise<void> {
  const res = await context.request.post(`${BASE_URL}/api/admin/auth`, {
    data: { key: adminKey },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(
    res.status(),
    `Admin auth failed with status ${res.status()} — check ADMIN_API_KEY ` +
      `against ${BASE_URL}/api/admin/auth.`,
  ).toBe(200);
}

/**
 * Direct-DB seed of an audit row so /api/audits/:id/export-xlsx returns
 * 200 instead of 404 (which would skip stageStreamingExportFromHono and
 * produce a meaningless timing measurement). Matches the schema /
 * INSERT pattern from streamingExportLatency.integration.ts.
 */
async function setupTestAudit(pool: pg.Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS audits (
       id VARCHAR PRIMARY KEY,
       title TEXT NOT NULL,
       audit_number TEXT,
       type TEXT,
       status TEXT DEFAULT 'planned',
       created_at TIMESTAMP DEFAULT NOW()
     )`,
  );
  await pool.query(
    `INSERT INTO audits (id, title, status)
     VALUES ($1, $2, 'planned')
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title`,
    [TEST_AUDIT_ID, 'Streaming download per-route test audit'],
  );
}

async function cleanupTestAudit(pool: pg.Pool): Promise<void> {
  // grc_audit_findings.audit_id has ON DELETE CASCADE so seeded
  // findings (none here, but defensive) clean up automatically.
  await pool.query('DELETE FROM audits WHERE id = $1', [TEST_AUDIT_ID]);
}

interface PerRouteTiming {
  label: string;
  path: string;
  ttfbMs: number | null;
  totalMs: number;
  bytes: number;
  streamedToDisk: boolean;
  reason?: string;
}

test.describe('streamingDownload — per-route client-observed latency budget', () => {
  // The default 60s timeout would be tight for ~17 routes × up to a few
  // seconds each on a slow CI runner. 5 minutes is generous-but-finite;
  // a real hang still surfaces, just not as a green build.
  test.setTimeout(300_000);

  test('every streaming export route stays within client TTFB and total budgets', async ({
    page,
    context,
    browserName,
  }) => {
    console.log(
      `[streaming-per-route] running on ${browserName}, base=${BASE_URL}, ` +
        `ttfbBudget=${EXPORT_TTFB_BUDGET_MS}ms, totalBudget=${EXPORT_TOTAL_BUDGET_MS}ms`,
    );

    const adminKey = resolveAdminKey();
    if (!adminKey) {
      test.skip(
        true,
        'ADMIN_API_KEY / TEST_ADMIN_KEY not configured — skipping locally',
      );
    }

    // ── Optional pg setup for the audit-XLSX route ─────────────────────────
    let pool: pg.Pool | null = null;
    if (DATABASE_URL) {
      pool = new Pool({ connectionString: DATABASE_URL });
      await setupTestAudit(pool);
    } else if (process.env.CI === 'true') {
      throw new Error(
        'CI: DATABASE_URL missing — refusing to skip audit-XLSX coverage. ' +
          'Set DATABASE_URL so the per-route smoke can seed a test audit row.',
      );
    } else {
      console.warn(
        '[streaming-per-route] DATABASE_URL not set — skipping audit-XLSX ' +
          'route only; other routes still run.',
      );
    }

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) =>
      consoleErrors.push(`pageerror: ${err.message}`),
    );

    try {
      await authenticateAdmin(context, adminKey as string);

      // /vendors is a gated dashboard page that loads
      // /js/streaming-download.js and registers the streaming SW —
      // exactly the prerequisites window.streamingDownload() needs.
      await page.goto(`${BASE_URL}/vendors`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

      await page.waitForFunction(
        () => typeof (window as any).streamingDownload === 'function',
        undefined,
        { timeout: 15_000 },
      );

      const timings: PerRouteTiming[] = [];
      const failures: string[] = [];

      for (const route of EXPORT_ROUTES) {
        if (route.requiresSeededAudit && !pool) {
          console.log(
            `[streaming-per-route] SKIP ${route.label} (${route.path}) — ` +
              'no DATABASE_URL to seed required audit row.',
          );
          continue;
        }

        // Use test.step so each route appears as its own line in the
        // Playwright report and a per-route failure is visible at a
        // glance. We accumulate failures into `failures` instead of
        // throwing inside the step so one bad route does not skip the
        // others — the test fails at the end with a single aggregated
        // message naming every offender.
        await test.step(`${route.label} (${route.path})`, async () => {
          // Each iteration triggers a fresh download event from the SW
          // iframe path. Listen *before* invoking streamingDownload so
          // we never miss the event.
          const downloadPromise = page.waitForEvent('download', {
            timeout: 60_000,
          });

          let result: {
            ttfbMs: number | null;
            totalMs: number;
            bytes: number;
            streamedToDisk: boolean;
            entryName: string | null;
            error?: string;
          };

          try {
            result = await page.evaluate(
              async ({ url, adminKey, base }) => {
                // Force the SW streaming path on every engine; see the
                // file-header comments for the full rationale on each
                // of these knobs.
                try {
                  delete (window as any).showSaveFilePicker;
                } catch (_) {
                  /* ignore */
                }

                const sd = (window as any).streamingDownload as (
                  u: string,
                  o?: any,
                ) => Promise<any>;

                const t0 = performance.now();
                let res: any;
                try {
                  res = await sd(url, {
                    streamToDisk: 'always',
                    useServiceWorker: true,
                    skipEstimate: true,
                    showProgressUI: false,
                    showToast: false,
                    trackHistory: false,
                    fetchInit: { headers: { 'X-Admin-Key': adminKey } },
                  });
                } catch (err) {
                  return {
                    ttfbMs: null,
                    totalMs: performance.now() - t0,
                    bytes: 0,
                    streamedToDisk: false,
                    entryName: null,
                    error:
                      'streamingDownload threw: ' +
                      ((err as Error)?.message || String(err)),
                  };
                }
                const totalMs = performance.now() - t0;

                // Find the export fetch entry. We match by absolute URL
                // (origin + path) so a stray entry from another script
                // that happens to share a path suffix can't be picked
                // up. We scan from the end because the latest entry is
                // the one we just generated.
                const wantUrl = base + url;
                const entries =
                  performance.getEntriesByType('resource') as PerformanceResourceTiming[];
                let entry: PerformanceResourceTiming | undefined;
                for (let i = entries.length - 1; i >= 0; i--) {
                  if (entries[i].name === wantUrl) {
                    entry = entries[i];
                    break;
                  }
                }

                // responseStart is when the first byte of the body
                // arrived; requestStart is when the request was sent.
                // The difference is the user-observed TTFB including
                // network and server time. Both can be 0 on cross-
                // origin / opaque entries — guard against that.
                let ttfbMs: number | null = null;
                if (
                  entry &&
                  entry.responseStart > 0 &&
                  entry.requestStart > 0
                ) {
                  ttfbMs = Math.round(
                    entry.responseStart - entry.requestStart,
                  );
                }

                return {
                  ttfbMs,
                  totalMs: Math.round(totalMs),
                  bytes: Number(res?.bytes ?? 0),
                  streamedToDisk: !!res?.streamedToDisk,
                  entryName: entry ? entry.name : null,
                };
              },
              { url: route.path, adminKey: adminKey as string, base: BASE_URL },
            );
          } catch (err) {
            failures.push(
              `${route.label} (${route.path}): page.evaluate threw — ` +
                ((err as Error)?.message || String(err)),
            );
            return;
          }

          // Drain the browser download event so it does not leak into
          // the next route's waitForEvent. Best-effort: a route that
          // legitimately failed before triggering the download will
          // time out here, which is information we want surfaced.
          try {
            await downloadPromise;
          } catch (err) {
            failures.push(
              `${route.label} (${route.path}): no browser download event ` +
                `fired within timeout — the SW iframe trigger may have ` +
                `failed. ${(err as Error)?.message ?? ''}`.trim(),
            );
          }

          timings.push({
            label: route.label,
            path: route.path,
            ttfbMs: result.ttfbMs,
            totalMs: result.totalMs,
            bytes: result.bytes,
            streamedToDisk: result.streamedToDisk,
            reason: result.error,
          });

          // ── Per-route assertions, accumulated into `failures` ────────
          if (result.error) {
            failures.push(
              `${route.label} (${route.path}): ${result.error}`,
            );
            return;
          }

          if (!result.streamedToDisk) {
            failures.push(
              `${route.label} (${route.path}): streamedToDisk=false — fell ` +
                'back to in-memory Blob path; the SW streaming pipeline ' +
                'regressed for this route.',
            );
          }

          if (result.bytes <= 0) {
            failures.push(
              `${route.label} (${route.path}): zero bytes received — ` +
                'streaming pipeline produced no body.',
            );
          }

          if (result.ttfbMs === null) {
            failures.push(
              `${route.label} (${route.path}): no PerformanceResourceTiming ` +
                'entry found for the export fetch — cannot measure ' +
                'client-observed TTFB. (entryName=' +
                String(result.entryName) +
                ')',
            );
          } else if (result.ttfbMs > EXPORT_TTFB_BUDGET_MS) {
            failures.push(
              `${route.label} (${route.path}): client-observed TTFB ` +
                `${result.ttfbMs}ms exceeds budget ` +
                `${EXPORT_TTFB_BUDGET_MS}ms (network + server). ` +
                'A regression here means real users are waiting longer for ' +
                'the first byte than the server-only header reports — ' +
                'investigate TLS/edge buffering or service-worker overhead.',
            );
          }

          if (result.totalMs > EXPORT_TOTAL_BUDGET_MS) {
            failures.push(
              `${route.label} (${route.path}): client-observed total ` +
                `${result.totalMs}ms exceeds budget ` +
                `${EXPORT_TOTAL_BUDGET_MS}ms (full SW round-trip + ` +
                `last-byte). Bytes=${result.bytes}, ` +
                `streamedToDisk=${result.streamedToDisk}.`,
            );
          }

          console.log(
            `[streaming-per-route] ${route.label.padEnd(18)} ` +
              `${route.path.padEnd(38)} ` +
              `ttfb=${result.ttfbMs ?? '—'}ms ` +
              `total=${result.totalMs}ms ` +
              `bytes=${result.bytes} ` +
              `streamedToDisk=${result.streamedToDisk}`,
          );
        });
      }

      // ── Summary table for CI triagers ─────────────────────────────────
      console.log(
        `\n[streaming-per-route] summary (sorted by client TTFB desc):`,
      );
      const sorted = [...timings].sort(
        (a, b) => (b.ttfbMs ?? -1) - (a.ttfbMs ?? -1),
      );
      for (const t of sorted) {
        const ttfb =
          t.ttfbMs === null ? '—'.padStart(6) : `${t.ttfbMs}`.padStart(6);
        const total = `${t.totalMs}`.padStart(6);
        const bytes = `${t.bytes}`.padStart(8);
        console.log(
          `  ttfb=${ttfb}ms total=${total}ms bytes=${bytes} ` +
            `swStream=${t.streamedToDisk ? 'y' : 'n'} ${t.path}`,
        );
      }

      expect(
        failures,
        '\n[streaming-per-route] PER-ROUTE CLIENT-BUDGET VIOLATIONS:\n  - ' +
          (failures.join('\n  - ') || '(none)') +
          '\n\nConsole errors during run:\n  ' +
          (consoleErrors.join('\n  ') || '(none)'),
      ).toEqual([]);
    } finally {
      if (pool) {
        try {
          await cleanupTestAudit(pool);
        } catch (e) {
          console.warn(
            `[streaming-per-route] cleanupTestAudit failed: ` +
              `${(e as Error).message}`,
          );
        }
        try {
          await pool.end();
        } catch (_) {
          /* ignore */
        }
      }
    }
  });
});
