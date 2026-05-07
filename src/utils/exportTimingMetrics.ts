/**
 * Export-timing rolling p95 alert (Task #440)
 *
 * Background
 * ----------
 * `instrumentExportResponseTiming` in `src/utils/excelExport.ts` already emits
 * a structured `[export-timing]` log line for every streaming export response
 * and stamps `X-Stream-TTFB-Ms` on the response. Today those signals are only
 * consumed by the CI integration test (`tests/streamingExportLatency.integration.ts`).
 * In production they go to logs, but nothing watches them — a regression that
 * buffers a single export endpoint will only be discovered the next time CI
 * runs the smoke workflow, possibly days later.
 *
 * What this module does
 * ---------------------
 *   1. `recordExportTimingSample()` — called from `instrumentExportResponseTiming`
 *      for every completed (or cancelled / errored) streaming export response.
 *      Samples are aggregated in-memory in a rolling per-route window keyed on
 *      the same low-cardinality `routeLabel` the log line uses.
 *   2. `evaluateExportTimingAlert()` — pure helper that takes the current
 *      snapshot and returns the set of routes whose rolling p95 of TTFB or
 *      total duration is over budget for at least `minSamples` calls in the
 *      window. Shared between the cron and any future dashboard surface so
 *      they cannot drift.
 *   3. `runExportTimingAlertCheck()` — Inngest-cron entry point. Writes a
 *      `system_event` (audit trail), emits a structured `logger.warn` (so log
 *      shippers see it), and best-effort fans out to Slack + email. Repeat
 *      suppression keyed on the route label prevents flapping during a
 *      sustained regression.
 *
 * Why in-memory and not a metrics backend?
 * ----------------------------------------
 * The platform does not currently ship with Prometheus or a hosted metrics
 * sink, and the existing observability primitives (`system_events` table,
 * Slack/email fan-out, Inngest crons) are already used by every other
 * "watch the rolling window for a regression" alert in the codebase
 * (rateLimit429SpikeAlert, toolHealthAlertNotifier). Mirroring that shape
 * keeps a single mental model for on-call.
 *
 * Memory footprint is bounded: per-route ring of at most
 * `EXPORT_TIMING_WINDOW_MAX_SAMPLES` (default 500) numeric samples.
 *
 * Configuration (env vars)
 * ------------------------
 *   EXPORT_TIMING_ALERT_MIN_SAMPLES    — minimum samples in the window before
 *                                        a route can fire. Default 5. Avoids
 *                                        paging on a single slow request.
 *   EXPORT_TIMING_ALERT_REPEAT_HOURS   — suppression window for repeat pages
 *                                        on the same route + reason. Default 1.
 *   EXPORT_TIMING_WINDOW_MAX_SAMPLES   — ring-buffer size per route. Default
 *                                        500. Effectively bounds the rolling
 *                                        window length.
 *   EXPORT_TIMING_WINDOW_MAX_AGE_MIN   — drop samples older than this many
 *                                        minutes when computing the snapshot.
 *                                        Default 60.
 *   EXPORT_TIMING_SLACK_WEBHOOK_URL    — optional Slack webhook for the page.
 *                                        Falls back to SLACK_WEBHOOK_URL.
 *   EXPORT_TIMING_ALERT_EMAIL          — comma-separated recipient list.
 *   EXPORT_TIMING_ALERT_CRON           — cron expression, default "*\/5 * * * *".
 *   EXPORT_TIMING_ALERT_DISABLED       — set to "1" to disable the alert
 *                                        without removing the cron.
 *
 * Runbook: see `docs/runbook-export-timing-alert.md`.
 */

import pino from "pino";

import {
  EXPORT_TTFB_BUDGET_MS,
  EXPORT_TOTAL_BUDGET_MS,
} from "./excelExport";
import { logger as safeLogger } from "./logger";

const logger = pino({ level: "warn", name: "exportTimingMetrics" });

// ──────────────────────────────────────────────────────────────────────────────
// Sample buffer
// ──────────────────────────────────────────────────────────────────────────────

interface ExportTimingSample {
  ttfbMs: number;
  totalMs: number;
  bytes: number;
  status: string;
  recordedAt: number;
}

interface RouteWindow {
  samples: ExportTimingSample[];
  /** Position in the ring buffer for the next write. */
  next: number;
}

const windowsByRoute = new Map<string, RouteWindow>();

function envPosInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function maxSamplesPerRoute(): number {
  return envPosInt("EXPORT_TIMING_WINDOW_MAX_SAMPLES", 500);
}

function maxAgeMs(): number {
  return envPosInt("EXPORT_TIMING_WINDOW_MAX_AGE_MIN", 60) * 60_000;
}

export function getExportTimingMinSamples(): number {
  return envPosInt("EXPORT_TIMING_ALERT_MIN_SAMPLES", 5);
}

export function getExportTimingRepeatHours(): number {
  return envPosInt("EXPORT_TIMING_ALERT_REPEAT_HOURS", 1);
}

/**
 * Record a single completed-export sample. Called from
 * `instrumentExportResponseTiming` once per response (on close / cancel /
 * error). Cheap O(1) — a bounded ring buffer per route.
 *
 * Cancellations and errors are recorded too so the snapshot reflects what
 * the operator would actually see in the log; the alert evaluator filters
 * to `status="ok"` or `status="over-budget"` so a flood of client-side
 * cancellations does not skew p95.
 */
export function recordExportTimingSample(sample: {
  routeLabel: string;
  ttfbMs: number;
  totalMs: number;
  bytes: number;
  status: string;
}): void {
  const cap = maxSamplesPerRoute();
  let bucket = windowsByRoute.get(sample.routeLabel);
  if (!bucket) {
    bucket = { samples: [], next: 0 };
    windowsByRoute.set(sample.routeLabel, bucket);
  }
  const entry: ExportTimingSample = {
    ttfbMs: Math.max(0, Math.round(sample.ttfbMs)),
    totalMs: Math.max(0, Math.round(sample.totalMs)),
    bytes: Math.max(0, Math.round(sample.bytes)),
    status: sample.status,
    recordedAt: Date.now(),
  };
  if (bucket.samples.length < cap) {
    bucket.samples.push(entry);
  } else {
    bucket.samples[bucket.next] = entry;
    bucket.next = (bucket.next + 1) % cap;
  }
}

/** Visible to tests so each case starts with a clean rolling window. */
export function _resetExportTimingMetricsForTests(): void {
  windowsByRoute.clear();
}

// ──────────────────────────────────────────────────────────────────────────────
// Snapshot + p95
// ──────────────────────────────────────────────────────────────────────────────

export interface RouteTimingSnapshot {
  routeLabel: string;
  sampleCount: number;
  p95TtfbMs: number;
  p95TotalMs: number;
  maxTtfbMs: number;
  maxTotalMs: number;
}

/**
 * Nearest-rank p95: returns the value at index ceil(0.95 * n) - 1 of the
 * sorted ascending array. Cheaper than full quantile interpolation and
 * stable for small windows where interpolation overstates the tail.
 */
function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx];
}

export interface SnapshotOptions {
  /** Override the max-age cutoff (ms). Defaults to env config. */
  maxAgeMs?: number;
  /** Override "now" for deterministic tests. */
  now?: () => number;
}

/**
 * Snapshot the current per-route window. Samples older than `maxAgeMs` are
 * excluded. Status="cancelled" / "error" samples are filtered out so a wave
 * of client disconnects (typical after a deploy) does not drag p95 in
 * either direction.
 */
export function snapshotExportTimingMetrics(
  options: SnapshotOptions = {},
): RouteTimingSnapshot[] {
  const cutoffAgeMs = options.maxAgeMs ?? maxAgeMs();
  const now = (options.now ?? Date.now)();
  const result: RouteTimingSnapshot[] = [];
  for (const [routeLabel, bucket] of windowsByRoute.entries()) {
    const recent = bucket.samples.filter(
      (s) =>
        now - s.recordedAt <= cutoffAgeMs &&
        (s.status === "ok" || s.status === "over-budget"),
    );
    if (recent.length === 0) continue;
    const ttfb = recent.map((s) => s.ttfbMs);
    const total = recent.map((s) => s.totalMs);
    result.push({
      routeLabel,
      sampleCount: recent.length,
      p95TtfbMs: p95(ttfb),
      p95TotalMs: p95(total),
      maxTtfbMs: Math.max(...ttfb),
      maxTotalMs: Math.max(...total),
    });
  }
  // Stable sort so log lines / dashboards group identically across ticks.
  result.sort((a, b) => a.routeLabel.localeCompare(b.routeLabel));
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// Pure evaluator
// ──────────────────────────────────────────────────────────────────────────────

export type ExportTimingBreachReason = "ttfb_p95" | "total_p95";

export interface ExportTimingBreach {
  routeLabel: string;
  reason: ExportTimingBreachReason;
  observedMs: number;
  budgetMs: number;
  sampleCount: number;
}

export interface ExportTimingEvaluation {
  /** Per-route, per-reason breach list. A single route can appear twice. */
  breaches: ExportTimingBreach[];
  /** Snapshot the evaluator saw, echoed for log lines / dashboards. */
  snapshot: RouteTimingSnapshot[];
  /** Effective minSamples cutoff (after env read). */
  minSamples: number;
}

export interface EvaluateOptions {
  minSamples?: number;
  ttfbBudgetMs?: number;
  totalBudgetMs?: number;
}

/**
 * Pure helper: given a snapshot and the configured budgets, return the list
 * of (route, reason) pairs that should fire an alert. Routes with fewer
 * than `minSamples` recent samples are intentionally skipped — a single
 * slow cold-start request must not page on-call.
 */
export function evaluateExportTimingAlert(
  snapshot: RouteTimingSnapshot[],
  options: EvaluateOptions = {},
): ExportTimingEvaluation {
  const minSamples = options.minSamples ?? getExportTimingMinSamples();
  const ttfbBudget = options.ttfbBudgetMs ?? EXPORT_TTFB_BUDGET_MS;
  const totalBudget = options.totalBudgetMs ?? EXPORT_TOTAL_BUDGET_MS;
  const breaches: ExportTimingBreach[] = [];
  for (const row of snapshot) {
    if (row.sampleCount < minSamples) continue;
    if (row.p95TtfbMs > ttfbBudget) {
      breaches.push({
        routeLabel: row.routeLabel,
        reason: "ttfb_p95",
        observedMs: row.p95TtfbMs,
        budgetMs: ttfbBudget,
        sampleCount: row.sampleCount,
      });
    }
    if (row.p95TotalMs > totalBudget) {
      breaches.push({
        routeLabel: row.routeLabel,
        reason: "total_p95",
        observedMs: row.p95TotalMs,
        budgetMs: totalBudget,
        sampleCount: row.sampleCount,
      });
    }
  }
  return { breaches, snapshot, minSamples };
}

// ──────────────────────────────────────────────────────────────────────────────
// Cron entry
// ──────────────────────────────────────────────────────────────────────────────

export interface ExportTimingAlertCheckResult {
  /** True iff at least one breach was observed (regardless of dedupe). */
  active: boolean;
  /** The breaches that were considered for paging this tick. */
  breaches: ExportTimingBreach[];
  /** Subset of `breaches` for which a system_event was actually written. */
  emittedBreaches: ExportTimingBreach[];
  /** Subset of `breaches` that were suppressed because we paged recently. */
  suppressedBreaches: ExportTimingBreach[];
  /** True iff at least one Slack post was attempted and succeeded. */
  slackSent: boolean;
  /** True iff at least one email was attempted and succeeded. */
  emailSent: boolean;
  /** Diagnostic reason. */
  reason: "disabled" | "no_samples" | "below_threshold" | "above_threshold";
}

export interface ExportTimingAlertDeps {
  /** Snapshot source — defaults to the in-memory window. */
  fetchSnapshot?: (options?: SnapshotOptions) => RouteTimingSnapshot[];
  /** Recency check — counts existing alerts for `<route>:<reason>` in the last `withinHours`. */
  countRecentEmissions?: (
    routeLabel: string,
    reason: ExportTimingBreachReason,
    withinHours: number,
  ) => Promise<number>;
  /** Defaults to `logSystemEvent`. */
  emitSystemEvent?: (payload: {
    description: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  /** Defaults to fetch-to-Slack-webhook (no-op when not configured). */
  postSlack?: (text: string) => Promise<boolean>;
  /** Defaults to `sendResendEmail` (no-op when not configured). */
  sendEmail?: (subject: string, html: string, text: string) => Promise<boolean>;
  /** Override min-samples (mostly for tests). */
  minSamples?: number;
  /** Override repeat-suppression window in hours (mostly for tests). */
  repeatHours?: number;
}

const DEFAULT_COUNT_RECENT: NonNullable<
  ExportTimingAlertDeps["countRecentEmissions"]
> = async (routeLabel, reason, withinHours) => {
  // Lazy-import to avoid pulling pg into modules that don't need it.
  const { sharedPool } = await import("./sharedPool");
  const r = await sharedPool.query<{ count: string }>(
    `SELECT COUNT(*)::bigint AS count
       FROM system_events
      WHERE event_type = 'export_timing_p95_alert'
        AND metadata->>'route_label' = $1
        AND metadata->>'reason' = $2
        AND created_at > NOW() - ($3::int * INTERVAL '1 hour')`,
    [routeLabel, reason, withinHours],
  );
  return parseInt(r.rows[0]?.count ?? "0", 10);
};

const DEFAULT_EMIT_EVENT: NonNullable<
  ExportTimingAlertDeps["emitSystemEvent"]
> = async ({ description, metadata }) => {
  const { logSystemEvent } = await import("./database");
  await logSystemEvent({
    event_type: "export_timing_p95_alert",
    event_category: "performance",
    description,
    severity: "warning",
    source: "exportTimingMetrics",
    metadata,
  });
};

const DEFAULT_POST_SLACK: NonNullable<
  ExportTimingAlertDeps["postSlack"]
> = async (text) => {
  const url =
    process.env.EXPORT_TIMING_SLACK_WEBHOOK_URL ||
    process.env.SLACK_WEBHOOK_URL ||
    "";
  if (!url) return false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      logger.warn(
        {
          status: response.status,
          statusText: response.statusText,
          component: "exportTimingMetrics",
        },
        "Slack webhook returned non-2xx — alert was already written to system_events",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, component: "exportTimingMetrics" },
      "Slack webhook POST failed — alert was already written to system_events",
    );
    return false;
  }
};

const DEFAULT_SEND_EMAIL: NonNullable<
  ExportTimingAlertDeps["sendEmail"]
> = async (subject, html, text) => {
  const raw = (process.env.EXPORT_TIMING_ALERT_EMAIL || "").trim();
  if (!raw) return false;
  const recipients = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (recipients.length === 0) return false;
  try {
    const { sendResendEmail } = await import("./resendMail");
    const r = await sendResendEmail({ to: recipients, subject, html, text });
    return !!r?.success;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, component: "exportTimingMetrics" },
      "Email send failed — alert was already written to system_events",
    );
    return false;
  }
};

function reasonLabel(reason: ExportTimingBreachReason): string {
  return reason === "ttfb_p95" ? "TTFB p95" : "Total p95";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBreachesText(breaches: ExportTimingBreach[]): string {
  if (breaches.length === 0) return "(none)";
  return breaches
    .map(
      (b) =>
        `  • ${b.routeLabel} — ${reasonLabel(b.reason)} ${b.observedMs}ms ` +
        `> budget ${b.budgetMs}ms (n=${b.sampleCount})`,
    )
    .join("\n");
}

function formatBreachesHtml(breaches: ExportTimingBreach[]): string {
  if (breaches.length === 0) return "<p><em>(none)</em></p>";
  const rows = breaches
    .map(
      (b) =>
        `<tr>
          <td style="padding:4px 8px;font-family:monospace">${escapeHtml(b.routeLabel)}</td>
          <td style="padding:4px 8px">${reasonLabel(b.reason)}</td>
          <td style="padding:4px 8px;text-align:right">${b.observedMs}</td>
          <td style="padding:4px 8px;text-align:right">${b.budgetMs}</td>
          <td style="padding:4px 8px;text-align:right">${b.sampleCount}</td>
        </tr>`,
    )
    .join("\n");
  return `<table border="1" cellspacing="0" cellpadding="0"
    style="border-collapse:collapse;font-size:13px">
    <thead style="background:#f5f5f5">
      <tr>
        <th style="padding:4px 8px">Route</th>
        <th style="padding:4px 8px">Reason</th>
        <th style="padding:4px 8px">Observed (ms)</th>
        <th style="padding:4px 8px">Budget (ms)</th>
        <th style="padding:4px 8px">Samples</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Run the export-timing p95 alert check. Idempotent and safe to call from
 * the cron — the per-(route, reason) repeat-suppression window prevents
 * flapping during a sustained regression.
 *
 * Never throws — DB / Slack / email failures are caught and surfaced via
 * the result so the cron's bookkeeping stays intact.
 */
export async function runExportTimingAlertCheck(
  depsOverride: ExportTimingAlertDeps = {},
): Promise<ExportTimingAlertCheckResult> {
  if (process.env.EXPORT_TIMING_ALERT_DISABLED === "1") {
    return {
      active: false,
      breaches: [],
      emittedBreaches: [],
      suppressedBreaches: [],
      slackSent: false,
      emailSent: false,
      reason: "disabled",
    };
  }

  const fetchSnapshot =
    depsOverride.fetchSnapshot ?? snapshotExportTimingMetrics;
  const countRecent =
    depsOverride.countRecentEmissions ?? DEFAULT_COUNT_RECENT;
  const emitEvent = depsOverride.emitSystemEvent ?? DEFAULT_EMIT_EVENT;
  const postSlack = depsOverride.postSlack ?? DEFAULT_POST_SLACK;
  const sendEmail = depsOverride.sendEmail ?? DEFAULT_SEND_EMAIL;
  const minSamples = depsOverride.minSamples ?? getExportTimingMinSamples();
  const repeatHours = depsOverride.repeatHours ?? getExportTimingRepeatHours();

  const snapshot = fetchSnapshot();
  if (snapshot.length === 0) {
    return {
      active: false,
      breaches: [],
      emittedBreaches: [],
      suppressedBreaches: [],
      slackSent: false,
      emailSent: false,
      reason: "no_samples",
    };
  }

  const evaluation = evaluateExportTimingAlert(snapshot, { minSamples });
  if (evaluation.breaches.length === 0) {
    return {
      active: false,
      breaches: [],
      emittedBreaches: [],
      suppressedBreaches: [],
      slackSent: false,
      emailSent: false,
      reason: "below_threshold",
    };
  }

  // Per-(route, reason) dedupe so a sustained regression on a single endpoint
  // pages once per repeatHours rather than every tick. Routes that we haven't
  // paged for recently still fire even if a sibling route is suppressed.
  const fresh: ExportTimingBreach[] = [];
  const suppressed: ExportTimingBreach[] = [];
  for (const breach of evaluation.breaches) {
    let recent = 0;
    try {
      recent = await countRecent(breach.routeLabel, breach.reason, repeatHours);
    } catch (err) {
      // Better to over-page than miss a regression — treat dedupe failure as
      // "not recently paged" and let the alert through.
      logger.warn(
        {
          err: (err as Error).message,
          routeLabel: breach.routeLabel,
          reason: breach.reason,
          component: "exportTimingMetrics",
        },
        "countRecentEmissions threw — proceeding with alert",
      );
    }
    if (recent > 0) {
      suppressed.push(breach);
    } else {
      fresh.push(breach);
    }
  }

  if (fresh.length === 0) {
    safeLogger.warn(
      `[ExportTimingAlert] ${suppressed.length} breach(es) still active but ` +
        `all paged within the last ${repeatHours}h — suppressing repeat page.`,
    );
    return {
      active: true,
      breaches: evaluation.breaches,
      emittedBreaches: [],
      suppressedBreaches: suppressed,
      slackSent: false,
      emailSent: false,
      reason: "above_threshold",
    };
  }

  // Write one system_event per fresh breach so the audit trail is granular
  // enough to graph "which route regressed when". We deliberately don't
  // collapse multi-route breaches into a single row — that would lose the
  // per-route timestamp the dashboard's activity feed depends on.
  const emitted: ExportTimingBreach[] = [];
  for (const breach of fresh) {
    const description =
      `Export ${reasonLabel(breach.reason)} over budget on ${breach.routeLabel}: ` +
      `${breach.observedMs}ms > ${breach.budgetMs}ms (n=${breach.sampleCount}).`;
    const metadata = {
      route_label: breach.routeLabel,
      reason: breach.reason,
      observed_ms: breach.observedMs,
      budget_ms: breach.budgetMs,
      sample_count: breach.sampleCount,
      ttfb_budget_ms: EXPORT_TTFB_BUDGET_MS,
      total_budget_ms: EXPORT_TOTAL_BUDGET_MS,
      repeat_hours: repeatHours,
    };
    try {
      await emitEvent({ description, metadata });
      emitted.push(breach);
      safeLogger.warn(`[ExportTimingAlert] ${description}`);
    } catch (err) {
      logger.warn(
        {
          err: (err as Error).message,
          routeLabel: breach.routeLabel,
          reason: breach.reason,
          component: "exportTimingMetrics",
        },
        "emitSystemEvent threw — Slack/email still attempted",
      );
    }
  }

  // Best-effort fan-out — single combined Slack/email per tick (a wave of
  // simultaneous breaches almost always means a shared root cause; one page
  // with the whole list is more useful to on-call than N separate pings).
  const slackText =
    `:hourglass_flowing_sand: *Export endpoint p95 over budget* — ` +
    `${fresh.length} fresh breach(es) (suppressed ${suppressed.length}).\n` +
    `*Breaches:*\n${formatBreachesText(fresh)}\n\n` +
    `Runbook: \`docs/runbook-export-timing-alert.md\`. ` +
    `Budget constants live in \`src/utils/excelExport.ts\` ` +
    `(\`EXPORT_TTFB_BUDGET_MS\`, \`EXPORT_TOTAL_BUDGET_MS\`).`;
  let slackSent = false;
  try {
    slackSent = await postSlack(slackText);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, component: "exportTimingMetrics" },
      "postSlack threw",
    );
  }

  const distinctRoutes = new Set(fresh.map((b) => b.routeLabel)).size;
  const emailSubject = `⚠️ WalaPlus export latency over budget — ${distinctRoutes} route(s) / ${fresh.length} breach(es)`;
  const emailHtml = `<h2>Export Timing Over Budget</h2>
<p><strong>${fresh.length}</strong> export route(s) are over their rolling-p95 latency
budget (suppressed: <strong>${suppressed.length}</strong> repeat).</p>
<h3>Breaches</h3>
${formatBreachesHtml(fresh)}
<p>Runbook: <code>docs/runbook-export-timing-alert.md</code>.<br>
Budget constants live in <code>src/utils/excelExport.ts</code>
(<code>EXPORT_TTFB_BUDGET_MS</code>, <code>EXPORT_TOTAL_BUDGET_MS</code>).</p>`;
  const emailText =
    `Export endpoint p95 over budget — ${fresh.length} fresh ` +
    `(suppressed ${suppressed.length}).\n\n` +
    `Breaches:\n${formatBreachesText(fresh)}\n\n` +
    `Runbook: docs/runbook-export-timing-alert.md\n` +
    `Budget constants: src/utils/excelExport.ts ` +
    `(EXPORT_TTFB_BUDGET_MS, EXPORT_TOTAL_BUDGET_MS).`;
  let emailSent = false;
  try {
    emailSent = await sendEmail(emailSubject, emailHtml, emailText);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, component: "exportTimingMetrics" },
      "sendEmail threw",
    );
  }

  return {
    active: true,
    breaches: evaluation.breaches,
    emittedBreaches: emitted,
    suppressedBreaches: suppressed,
    slackSent,
    emailSent,
    reason: "above_threshold",
  };
}
