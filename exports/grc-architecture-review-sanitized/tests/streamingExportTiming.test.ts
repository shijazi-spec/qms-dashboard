/**
 * Unit tests for `instrumentExportResponseTiming` — the helper that stamps
 * X-Stream-TTFB-Ms / X-Stream-Total-Budget-Ms on every streaming export
 * response and logs total transfer duration when the body finishes.
 *
 * These tests run in-process and do NOT require a live HTTP server. The
 * end-to-end check that real export endpoints actually pass through this
 * wrapper lives in tests/streamingExportLatency.integration.ts (gated on
 * RUN_STREAMING_EXPORT_LATENCY_E2E=1 because it needs the dev server).
 *
 * Run with:  npx tsx tests/streamingExportTiming.test.ts
 */

import { TestSuite } from "./_helpers/runner.js";
import {
  instrumentExportResponseTiming,
  EXPORT_TIMING_HEADERS,
  EXPORT_TTFB_BUDGET_MS,
  EXPORT_TOTAL_BUDGET_MS,
} from "../src/utils/excelExport.js";

const suite = new TestSuite("streamingExportTiming");

function fixedBodyResponse(body: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="x.csv"',
    },
  });
}

await suite.test(
  "stamps X-Stream-TTFB-Ms and budget headers on every wrapped response",
  async () => {
    const startedAt = performance.now() - 7; // pretend ~7ms have passed
    const wrapped = instrumentExportResponseTiming(
      fixedBodyResponse("a,b,c\n1,2,3\n"),
      startedAt,
      "GET /api/test/export",
    );

    const ttfb = wrapped.headers.get(EXPORT_TIMING_HEADERS.ttfb);
    suite.expect(ttfb !== null, "X-Stream-TTFB-Ms must be set");
    const n = Number(ttfb);
    suite.expect(Number.isFinite(n) && n >= 0, `TTFB must be a non-negative number, got ${ttfb}`);

    suite.expectEqual(
      wrapped.headers.get(EXPORT_TIMING_HEADERS.ttfbBudget),
      String(EXPORT_TTFB_BUDGET_MS),
      "ttfb budget header echoes the constant",
    );
    suite.expectEqual(
      wrapped.headers.get(EXPORT_TIMING_HEADERS.totalBudget),
      String(EXPORT_TOTAL_BUDGET_MS),
      "total budget header echoes the constant",
    );
  },
);

await suite.test(
  "Access-Control-Expose-Headers includes the X-Stream-* headers",
  async () => {
    const wrapped = instrumentExportResponseTiming(
      fixedBodyResponse("hello"),
      performance.now(),
      "GET /api/test/cors",
    );
    const expose = wrapped.headers.get("Access-Control-Expose-Headers") || "";
    suite.expect(
      expose.includes(EXPORT_TIMING_HEADERS.ttfb),
      `expose header must include ${EXPORT_TIMING_HEADERS.ttfb}, got "${expose}"`,
    );
    suite.expect(
      expose.includes(EXPORT_TIMING_HEADERS.ttfbBudget),
      `expose header must include ${EXPORT_TIMING_HEADERS.ttfbBudget}, got "${expose}"`,
    );
    suite.expect(
      expose.includes(EXPORT_TIMING_HEADERS.totalBudget),
      `expose header must include ${EXPORT_TIMING_HEADERS.totalBudget}, got "${expose}"`,
    );
  },
);

await suite.test(
  "preserves status, content-type, content-disposition from the underlying response",
  async () => {
    const wrapped = instrumentExportResponseTiming(
      fixedBodyResponse("payload", 206),
      performance.now(),
      "GET /api/test/range",
    );
    suite.expectEqual(wrapped.status, 206, "status echoed");
    suite.expectEqual(
      wrapped.headers.get("Content-Type"),
      "text/csv; charset=utf-8",
      "content-type echoed",
    );
    suite.expectEqual(
      wrapped.headers.get("Content-Disposition"),
      'attachment; filename="x.csv"',
      "content-disposition echoed",
    );
  },
);

await suite.test(
  "body bytes pass through unchanged (transparent passthrough)",
  async () => {
    const expected = "id,name\n1,Vendor A\n2,Vendor B\n";
    const wrapped = instrumentExportResponseTiming(
      fixedBodyResponse(expected),
      performance.now(),
      "GET /api/test/passthrough",
    );
    const got = await wrapped.text();
    suite.expectEqual(got, expected, "body bytes unchanged");
  },
);

await suite.test(
  "tolerates a bodyless response (e.g. 304/empty 200) without throwing",
  async () => {
    const empty = new Response(null, {
      status: 200,
      headers: { "Content-Type": "text/csv" },
    });
    const wrapped = instrumentExportResponseTiming(
      empty,
      performance.now(),
      "GET /api/test/empty",
    );
    suite.expectEqual(wrapped.status, 200, "status preserved");
    const ttfb = wrapped.headers.get(EXPORT_TIMING_HEADERS.ttfb);
    suite.expect(ttfb !== null, "TTFB still stamped on bodyless response");
    suite.expectEqual(wrapped.body, null, "body stays null");
  },
);

await suite.test(
  "TTFB reflects elapsed time since startedAt (not zero)",
  async () => {
    const startedAt = performance.now();
    await new Promise((r) => setTimeout(r, 25));
    const wrapped = instrumentExportResponseTiming(
      fixedBodyResponse("x"),
      startedAt,
      "GET /api/test/elapsed",
    );
    const ttfb = Number(wrapped.headers.get(EXPORT_TIMING_HEADERS.ttfb));
    suite.expect(
      ttfb >= 20,
      `TTFB should reflect ~25ms wait, got ${ttfb}ms`,
    );
  },
);

await suite.test(
  "TTFB-over-budget warning still produces a valid wrapped response",
  async () => {
    // Backdate startedAt to just past the budget so the wrapper logs a
    // warning. Verify the response is still well-formed and consumable.
    const startedAt = performance.now() - (EXPORT_TTFB_BUDGET_MS + 50);
    const wrapped = instrumentExportResponseTiming(
      fixedBodyResponse("hello"),
      startedAt,
      "GET /api/test/over-budget",
    );
    suite.expectEqual(wrapped.status, 200, "status preserved");
    const ttfb = Number(wrapped.headers.get(EXPORT_TIMING_HEADERS.ttfb));
    suite.expect(
      ttfb > EXPORT_TTFB_BUDGET_MS,
      `TTFB should be over budget, got ${ttfb}ms`,
    );
    const body = await wrapped.text();
    suite.expectEqual(body, "hello", "body still readable");
  },
);

await suite.test(
  "wrapper is backpressure-safe — does NOT eagerly drain the upstream",
  async () => {
    // Regression guard: an earlier version of `instrumentExportResponseTiming`
    // ran a `while (true) reader.read()` loop inside a `start()` callback,
    // which eagerly drained the entire upstream into the wrapper's queue
    // BEFORE any downstream consumer ever read a byte. That defeats
    // backpressure (and inflates memory) on multi-MB exports — the very
    // failure mode this whole task is meant to detect.
    //
    // We build a source of N chunks and count how many it produces before
    // the consumer has called `.read()` even once. A backpressure-safe
    // pull-based wrapper will stop after a small constant prefetch (the
    // standard ReadableStream highWaterMark stacking is at most ~2: one
    // chunk sitting in the source's internal queue, one in the wrapper's).
    // An eager drain would pull all N.
    const N = 50;
    let pullsBeforeFirstRead = 0;
    let consumerHasRead = false;
    let chunkIdx = 0;
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!consumerHasRead) pullsBeforeFirstRead++;
        if (chunkIdx >= N) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(`chunk-${chunkIdx}\n`));
        chunkIdx++;
      },
    });
    const wrapped = instrumentExportResponseTiming(
      new Response(source, {
        status: 200,
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      }),
      performance.now(),
      "GET /api/test/backpressure",
    );

    // Give the event loop a few turns so any eager drain has time to run.
    await new Promise((r) => setTimeout(r, 50));

    // Threshold: at most 4 prefetched chunks. Real-world HWM stacking is
    // 1-2 chunks. Anything close to N would mean the wrapper is draining
    // the entire upstream up front — the regression we are guarding
    // against. We pick 4 to leave headroom for impl-defined queueing
    // (Node's whatwg-streams has tiny variations in pre-pull behaviour).
    suite.expect(
      pullsBeforeFirstRead <= 4,
      `wrapper drained ${pullsBeforeFirstRead} of ${N} chunks before the ` +
        `consumer read — backpressure is broken (eager drain regression).`,
    );

    // Now drain via the consumer and verify content is intact + ordered.
    consumerHasRead = true;
    const body = await wrapped.text();
    const expected = Array.from({ length: N }, (_, i) => `chunk-${i}\n`).join("");
    suite.expectEqual(body, expected, "all chunks delivered in order after consumer read");
  },
);

await suite.test(
  "budget constants are positive integers",
  () => {
    suite.expect(
      Number.isInteger(EXPORT_TTFB_BUDGET_MS) && EXPORT_TTFB_BUDGET_MS > 0,
      `EXPORT_TTFB_BUDGET_MS must be a positive int, got ${EXPORT_TTFB_BUDGET_MS}`,
    );
    suite.expect(
      Number.isInteger(EXPORT_TOTAL_BUDGET_MS) && EXPORT_TOTAL_BUDGET_MS > 0,
      `EXPORT_TOTAL_BUDGET_MS must be a positive int, got ${EXPORT_TOTAL_BUDGET_MS}`,
    );
    suite.expect(
      EXPORT_TOTAL_BUDGET_MS >= EXPORT_TTFB_BUDGET_MS,
      `Total budget (${EXPORT_TOTAL_BUDGET_MS}) must be >= TTFB budget (${EXPORT_TTFB_BUDGET_MS})`,
    );
  },
);

suite.finishOrExit();
