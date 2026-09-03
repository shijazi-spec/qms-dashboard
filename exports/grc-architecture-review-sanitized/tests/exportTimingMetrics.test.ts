/**
 * Unit / behavior test for the export-endpoint p95 latency alert
 * (Task #440).
 *
 * Covers:
 *   1. recordExportTimingSample / snapshotExportTimingMetrics — bounded ring
 *      buffer per route, status filtering, max-age cutoff, p95 computation.
 *   2. evaluateExportTimingAlert — pure helper that decides which (route,
 *      reason) pairs should fire (minSamples gating, ttfb vs total budget).
 *   3. runExportTimingAlertCheck — the cron entry point with every external
 *      dep stubbed: disabled, no samples, below threshold, above threshold
 *      + no recent emissions, above threshold + recent emission (per-route
 *      dedupe), countRecent throws (proceed anyway), emit throws (ChatProvider +
 *      email still attempted).
 *
 * Pure / no DB needed — every dep is stubbed. Run via:
 *   npx tsx tests/exportTimingMetrics.test.ts
 * (also auto-discovered by `npm test` via tests/runIntegrationTests.ts).
 */

import {
  recordExportTimingSample,
  snapshotExportTimingMetrics,
  evaluateExportTimingAlert,
  runExportTimingAlertCheck,
  _resetExportTimingMetricsForTests,
  type RouteTimingSnapshot,
  type ExportTimingAlertDeps,
  type ExportTimingBreachReason,
} from "../src/utils/exportTimingMetrics";
import {
  EXPORT_TTFB_BUDGET_MS,
  EXPORT_TOTAL_BUDGET_MS,
} from "../src/utils/excelExport";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`, extra ?? "");
    failed++;
  }
}

interface StubInvocations {
  countRecentArgs: Array<{
    routeLabel: string;
    reason: ExportTimingBreachReason;
    withinHours: number;
  }>;
  emittedDescriptions: string[];
  emittedMetadata: Array<Record<string, unknown>>;
  ChatProviderCalls: string[];
  emailCalls: Array<{ subject: string; text: string }>;
}

function makeStubs(
  overrides: Partial<{
    snapshot: RouteTimingSnapshot[];
    recentEmissions: number;
    countThrows: boolean;
    emitThrows: boolean;
    ChatProviderReturns: boolean;
    emailReturns: boolean;
  }> = {},
): { deps: ExportTimingAlertDeps; invocations: StubInvocations } {
  const invocations: StubInvocations = {
    countRecentArgs: [],
    emittedDescriptions: [],
    emittedMetadata: [],
    ChatProviderCalls: [],
    emailCalls: [],
  };
  const deps: ExportTimingAlertDeps = {
    fetchSnapshot: () => overrides.snapshot ?? [],
    countRecentEmissions: async (routeLabel, reason, withinHours) => {
      invocations.countRecentArgs.push({ routeLabel, reason, withinHours });
      if (overrides.countThrows) throw new Error("synthetic-count-failure");
      return overrides.recentEmissions ?? 0;
    },
    emitSystemEvent: async ({ description, metadata }) => {
      invocations.emittedDescriptions.push(description);
      invocations.emittedMetadata.push(metadata);
      if (overrides.emitThrows) throw new Error("synthetic-emit-failure");
    },
    postChatProvider: async (text) => {
      invocations.ChatProviderCalls.push(text);
      return overrides.ChatProviderReturns ?? false;
    },
    sendEmail: async (subject, _html, text) => {
      invocations.emailCalls.push({ subject, text });
      return overrides.emailReturns ?? false;
    },
  };
  return { deps, invocations };
}

async function main(): Promise<void> {
  console.log("=== ring buffer + snapshot ===");
  {
    _resetExportTimingMetricsForTests();
    const route = "GET /api/audits/:id/export-xlsx";
    for (let i = 0; i < 10; i++) {
      recordExportTimingSample({
        routeLabel: route,
        ttfbMs: 100 + i * 10, // 100..190
        totalMs: 200 + i * 20, // 200..380
        bytes: 1024,
        status: "ok",
      });
    }
    const snap = snapshotExportTimingMetrics();
    check("snapshot has one route", snap.length === 1, snap);
    check("sampleCount = 10", snap[0].sampleCount === 10, snap[0]);
    // nearest-rank p95 of 10 sorted samples → index ceil(0.95*10)-1 = 9
    check("p95 ttfb = 190", snap[0].p95TtfbMs === 190, snap[0]);
    check("p95 total = 380", snap[0].p95TotalMs === 380, snap[0]);
    check("max ttfb = 190", snap[0].maxTtfbMs === 190);
  }

  console.log("=== status filter excludes cancelled / error ===");
  {
    _resetExportTimingMetricsForTests();
    const route = "GET /api/x/export";
    recordExportTimingSample({
      routeLabel: route,
      ttfbMs: 100,
      totalMs: 200,
      bytes: 0,
      status: "ok",
    });
    recordExportTimingSample({
      routeLabel: route,
      ttfbMs: 99_999,
      totalMs: 99_999,
      bytes: 0,
      status: "cancelled",
    });
    recordExportTimingSample({
      routeLabel: route,
      ttfbMs: 99_999,
      totalMs: 99_999,
      bytes: 0,
      status: "error",
    });
    const snap = snapshotExportTimingMetrics();
    check(
      "cancelled / error samples excluded from snapshot",
      snap[0].sampleCount === 1 &&
        snap[0].p95TtfbMs === 100 &&
        snap[0].p95TotalMs === 200,
      snap[0],
    );
  }

  console.log("=== max-age cutoff drops old samples ===");
  {
    _resetExportTimingMetricsForTests();
    recordExportTimingSample({
      routeLabel: "GET /api/old/export",
      ttfbMs: 50,
      totalMs: 100,
      bytes: 0,
      status: "ok",
    });
    // Snapshot with maxAgeMs=0 means NOTHING is recent → empty snapshot
    const snap = snapshotExportTimingMetrics({
      maxAgeMs: 0,
      now: () => Date.now() + 1,
    });
    check("max-age=0 filters out everything", snap.length === 0, snap);
  }

  console.log("=== ring buffer caps at maxSamples ===");
  {
    _resetExportTimingMetricsForTests();
    process.env.EXPORT_TIMING_WINDOW_MAX_SAMPLES = "3";
    try {
      const route = "GET /api/cap/export";
      for (const v of [10, 20, 30, 40, 50]) {
        recordExportTimingSample({
          routeLabel: route,
          ttfbMs: v,
          totalMs: v * 2,
          bytes: 0,
          status: "ok",
        });
      }
      const snap = snapshotExportTimingMetrics();
      check(
        "ring buffer caps at 3 — only the last 3 retained",
        snap[0].sampleCount === 3,
        snap[0],
      );
      // Last three writes: 30, 40, 50. p95 over 3 samples → idx ceil(2.85)-1 = 2 → 50.
      check("p95 of last 3 = 50", snap[0].p95TtfbMs === 50, snap[0]);
    } finally {
      delete process.env.EXPORT_TIMING_WINDOW_MAX_SAMPLES;
    }
  }

  console.log("=== evaluateExportTimingAlert — pure helper ===");
  {
    const snapshot: RouteTimingSnapshot[] = [
      {
        routeLabel: "GET /api/fast/export",
        sampleCount: 10,
        p95TtfbMs: EXPORT_TTFB_BUDGET_MS - 100,
        p95TotalMs: EXPORT_TOTAL_BUDGET_MS - 100,
        maxTtfbMs: EXPORT_TTFB_BUDGET_MS - 50,
        maxTotalMs: EXPORT_TOTAL_BUDGET_MS - 50,
      },
      {
        routeLabel: "GET /api/slow/export",
        sampleCount: 10,
        p95TtfbMs: EXPORT_TTFB_BUDGET_MS + 1,
        p95TotalMs: EXPORT_TOTAL_BUDGET_MS + 1,
        maxTtfbMs: EXPORT_TTFB_BUDGET_MS + 100,
        maxTotalMs: EXPORT_TOTAL_BUDGET_MS + 100,
      },
      {
        routeLabel: "GET /api/cold/export",
        sampleCount: 2,
        p95TtfbMs: EXPORT_TTFB_BUDGET_MS * 5,
        p95TotalMs: EXPORT_TOTAL_BUDGET_MS * 5,
        maxTtfbMs: EXPORT_TTFB_BUDGET_MS * 5,
        maxTotalMs: EXPORT_TOTAL_BUDGET_MS * 5,
      },
    ];
    const r = evaluateExportTimingAlert(snapshot, { minSamples: 5 });
    check(
      "exactly 2 breaches reported (slow ttfb + slow total)",
      r.breaches.length === 2,
      r.breaches,
    );
    check(
      "fast route not in breaches",
      !r.breaches.some((b) => b.routeLabel.includes("fast")),
      r.breaches,
    );
    check(
      "cold route skipped due to minSamples",
      !r.breaches.some((b) => b.routeLabel.includes("cold")),
      r.breaches,
    );
    check(
      "slow route appears with both reasons",
      r.breaches.some((b) => b.reason === "ttfb_p95") &&
        r.breaches.some((b) => b.reason === "total_p95"),
      r.breaches,
    );
  }

  console.log("=== runExportTimingAlertCheck — disabled ===");
  {
    process.env.EXPORT_TIMING_ALERT_DISABLED = "1";
    try {
      const { deps, invocations } = makeStubs({
        snapshot: [
          {
            routeLabel: "x",
            sampleCount: 10,
            p95TtfbMs: 99_999,
            p95TotalMs: 99_999,
            maxTtfbMs: 99_999,
            maxTotalMs: 99_999,
          },
        ],
      });
      const r = await runExportTimingAlertCheck(deps);
      check("disabled → reason=disabled", r.reason === "disabled", r);
      check("disabled → no events emitted", invocations.emittedDescriptions.length === 0);
      check("disabled → no ChatProvider", invocations.ChatProviderCalls.length === 0);
      check("disabled → no email", invocations.emailCalls.length === 0);
    } finally {
      delete process.env.EXPORT_TIMING_ALERT_DISABLED;
    }
  }

  console.log("=== runExportTimingAlertCheck — no samples ===");
  {
    const { deps } = makeStubs({ snapshot: [] });
    const r = await runExportTimingAlertCheck(deps);
    check("empty snapshot → reason=no_samples", r.reason === "no_samples", r);
    check("empty snapshot → not active", r.active === false);
  }

  console.log("=== runExportTimingAlertCheck — below threshold ===");
  {
    const { deps, invocations } = makeStubs({
      snapshot: [
        {
          routeLabel: "GET /api/healthy/export",
          sampleCount: 50,
          p95TtfbMs: 100,
          p95TotalMs: 200,
          maxTtfbMs: 150,
          maxTotalMs: 250,
        },
      ],
    });
    const r = await runExportTimingAlertCheck(deps);
    check("healthy snapshot → reason=below_threshold", r.reason === "below_threshold", r);
    check("healthy snapshot → no emit", invocations.emittedDescriptions.length === 0);
    check("healthy snapshot → no ChatProvider", invocations.ChatProviderCalls.length === 0);
  }

  console.log("=== runExportTimingAlertCheck — above threshold, fresh, fans out ===");
  {
    const { deps, invocations } = makeStubs({
      snapshot: [
        {
          routeLabel: "GET /api/slow/export",
          sampleCount: 20,
          p95TtfbMs: EXPORT_TTFB_BUDGET_MS + 500,
          p95TotalMs: EXPORT_TOTAL_BUDGET_MS + 1000,
          maxTtfbMs: EXPORT_TTFB_BUDGET_MS * 2,
          maxTotalMs: EXPORT_TOTAL_BUDGET_MS * 2,
        },
      ],
      recentEmissions: 0,
      ChatProviderReturns: true,
      emailReturns: true,
    });
    const r = await runExportTimingAlertCheck({
      ...deps,
      minSamples: 5,
      repeatHours: 1,
    });
    check("active=true", r.active === true && r.reason === "above_threshold", r);
    check("two breaches considered (ttfb + total)", r.breaches.length === 2);
    check("two events emitted", invocations.emittedDescriptions.length === 2);
    check(
      "countRecent called with repeatHours=1",
      invocations.countRecentArgs.every((a) => a.withinHours === 1),
      invocations.countRecentArgs,
    );
    check("ChatProvider POSTed once (combined message)", invocations.ChatProviderCalls.length === 1);
    check(
      "ChatProvider text mentions slow route",
      invocations.ChatProviderCalls[0].includes("/api/slow/export"),
    );
    check(
      "ChatProvider text mentions runbook",
      invocations.ChatProviderCalls[0].includes("docs/runbook-export-timing-alert.md"),
    );
    check("Email sent once", invocations.emailCalls.length === 1);
    check(
      "Email subject mentions distinct route count and breach count",
      invocations.emailCalls[0].subject.includes("1 route(s)") &&
        invocations.emailCalls[0].subject.includes("2 breach(es)"),
      invocations.emailCalls[0].subject,
    );
    check("result.ChatProviderSent reflects stub", r.ChatProviderSent === true);
    check("result.emailSent reflects stub", r.emailSent === true);
    // Verify metadata includes the route label so SQL dedupe later finds it.
    const md = invocations.emittedMetadata[0];
    check(
      "metadata.route_label set",
      md.route_label === "GET /api/slow/export",
      md,
    );
    check("metadata.reason in {ttfb_p95,total_p95}", md.reason === "ttfb_p95" || md.reason === "total_p95", md);
  }

  console.log("=== runExportTimingAlertCheck — recent emission suppresses repeat ===");
  {
    const { deps, invocations } = makeStubs({
      snapshot: [
        {
          routeLabel: "GET /api/slow/export",
          sampleCount: 20,
          p95TtfbMs: EXPORT_TTFB_BUDGET_MS + 500,
          p95TotalMs: 100,
          maxTtfbMs: EXPORT_TTFB_BUDGET_MS + 1000,
          maxTotalMs: 200,
        },
      ],
      recentEmissions: 1,
      ChatProviderReturns: true,
      emailReturns: true,
    });
    const r = await runExportTimingAlertCheck({
      ...deps,
      minSamples: 5,
      repeatHours: 6,
    });
    check("active=true (still over budget)", r.active === true);
    check("but no fresh emissions", invocations.emittedDescriptions.length === 0);
    check(
      "all suppressed",
      r.suppressedBreaches.length === 1 && r.emittedBreaches.length === 0,
      r,
    );
    check("no ChatProvider on full suppression", invocations.ChatProviderCalls.length === 0);
    check("no email on full suppression", invocations.emailCalls.length === 0);
  }

  console.log("=== runExportTimingAlertCheck — countRecent throws → proceed (over-page > miss) ===");
  {
    const { deps, invocations } = makeStubs({
      snapshot: [
        {
          routeLabel: "GET /api/slow/export",
          sampleCount: 20,
          p95TtfbMs: EXPORT_TTFB_BUDGET_MS + 500,
          p95TotalMs: 100,
          maxTtfbMs: 99_999,
          maxTotalMs: 200,
        },
      ],
      countThrows: true,
      ChatProviderReturns: true,
    });
    const r = await runExportTimingAlertCheck({
      ...deps,
      minSamples: 5,
      repeatHours: 1,
    });
    check("active=true", r.active === true);
    check(
      "alert still emitted despite countRecent failure",
      invocations.emittedDescriptions.length === 1,
    );
    check("ChatProvider still attempted", invocations.ChatProviderCalls.length === 1);
  }

  console.log("=== runExportTimingAlertCheck — emit throws → ChatProvider/email still attempted ===");
  {
    const { deps, invocations } = makeStubs({
      snapshot: [
        {
          routeLabel: "GET /api/slow/export",
          sampleCount: 20,
          p95TtfbMs: EXPORT_TTFB_BUDGET_MS + 500,
          p95TotalMs: 100,
          maxTtfbMs: 99_999,
          maxTotalMs: 200,
        },
      ],
      emitThrows: true,
      ChatProviderReturns: true,
      emailReturns: false,
    });
    const r = await runExportTimingAlertCheck({
      ...deps,
      minSamples: 5,
      repeatHours: 1,
    });
    check("active=true", r.active === true);
    check("emittedBreaches empty (emit threw)", r.emittedBreaches.length === 0);
    check("ChatProvider attempted", invocations.ChatProviderCalls.length === 1);
    check("Email attempted", invocations.emailCalls.length === 1);
    check("result.ChatProviderSent = true (stub)", r.ChatProviderSent === true);
    check("result.emailSent = false (stub)", r.emailSent === false);
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
