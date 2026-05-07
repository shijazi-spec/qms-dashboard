# Runbook — Export endpoint p95 over budget

**Alert source:** `export_timing_p95_alert` (system_events) /
Slack `EXPORT_TIMING_SLACK_WEBHOOK_URL` / email `EXPORT_TIMING_ALERT_EMAIL`.
**Cron:** `export-timing-p95-alert` (Inngest, default `*/5 * * * *`).
**Code:** `src/utils/exportTimingMetrics.ts` (helper),
`src/utils/excelExport.ts` (timing instrumentation + budget constants).

## What fired

The cron computed the rolling-window p95 of either time-to-first-byte
(`ttfb_p95`) or end-to-end transfer (`total_p95`) for one or more
streaming export routes and found the value above the configured budget
for **at least `EXPORT_TIMING_ALERT_MIN_SAMPLES` (default 5)** recent
calls.

The alert payload always includes:

| Field            | Meaning                                                        |
| ---------------- | -------------------------------------------------------------- |
| `route_label`    | Low-cardinality route, e.g. `GET /api/audits/:id/export-xlsx`. |
| `reason`         | `ttfb_p95` (server buffering / cold start) or `total_p95`.     |
| `observed_ms`    | The rolling p95 the cron measured this tick.                   |
| `budget_ms`      | The budget that was exceeded.                                  |
| `sample_count`   | Number of samples in the window (≥ minSamples).                |
| `repeat_hours`   | Suppression window currently in effect.                        |

## Triage

1. **Check whether the regression is real.** The same data the cron uses
   is in the server log as `[export-timing] <route> ttfb=…ms total=…ms
   bytes=… status=…` lines from
   `instrumentExportResponseTiming` in `src/utils/excelExport.ts`.
   Grep the last hour for the offending `route_label` and confirm the
   p95 trend.
2. **Look for the obvious culprit:** a recent deploy that touched the
   export route, a new middleware in front of it (auth/audit), or a
   database migration that invalidated an index used by the underlying
   `cursorQuery`. The `[export-timing] TTFB OVER BUDGET` warn line in
   the server log is emitted whenever a single request crosses the TTFB
   budget — its first appearance usually points at the bad deploy.
3. **If the problem is fixed**, no further action is needed: the p95
   will fall below budget within `EXPORT_TIMING_WINDOW_MAX_AGE_MIN`
   (default 60 min) once the slow samples age out of the rolling window,
   and the next cron tick will not re-page.

## Remediation

The most common regressions:

* **Buffering returned to the route.** A change replaced
  `streamXlsx` / `streamCsv` (or `stageStreamingExportFromHono`) with a
  full-body buffer + `c.body(buffer)`. Re-introduce streaming.
* **The cursor was replaced by `pagedQuery`.** The `[export-timing]`
  line will show `total` growing super-linearly with `bytes`. Switch
  back to `cursorQuery`.
* **A middleware now runs synchronously in front of the route.** TTFB
  rises but `total - ttfb` is unchanged. Move the middleware off the
  hot path or hoist its work into the cursor query.
* **Genuine workload growth.** Larger result sets (more rows, more
  columns) at unchanged code. Confirm with the row counts on the
  underlying tables, then either tighten the export's filters or raise
  the budget — see below.

## Raising the budget (intentional)

If on-call confirms the new latency is intentional, raise the budget in
**one place** so the CI smoke test, the cron, and the X-Stream-* response
headers all stay in lockstep:

`src/utils/excelExport.ts`

```ts
export const EXPORT_TTFB_BUDGET_MS = 5_000;   // ⬅ change here
export const EXPORT_TOTAL_BUDGET_MS = 10_000; // ⬅ change here
```

Then re-run `npx tsx tests/streamingExportTiming.test.ts` and the CI
`streaming-download-smoke` workflow to make sure nothing else asserts on
the old value, and explain the new range in the commit message.

## Operational scope (single-process visibility)

The rolling window is held **in-process** (`src/utils/exportTimingMetrics.ts`,
keyed on `routeLabel`). On a single Node worker this is exact: every
streaming export response feeds the same window the cron evaluates.

On a multi-instance deployment each worker holds its own window:
- The cron reads the window of whichever worker the Inngest tick lands
  on, so a regression that only manifests on one instance can take a few
  ticks to be visible.
- A regression that affects all instances pages on the first tick on
  whichever instance the cron lands on, because every instance crosses
  the budget independently.

This is acceptable for the current single-worker QMS deployment. If we
move to a horizontally-scaled topology, the follow-up is to back the
window with a shared store (Redis ring, or a `system_events`-backed
aggregate query) so the cron sees fleet-wide samples deterministically.

## Tuning the alert (without changing the budget)

The cron is intentionally chatty by default so a regression on a rarely
hit endpoint is not lost. To reduce noise on a noisy fleet:

| Env var                              | Default | Effect                                                                |
| ------------------------------------ | ------- | --------------------------------------------------------------------- |
| `EXPORT_TIMING_ALERT_MIN_SAMPLES`    | `5`     | Don't fire until N samples have landed in the rolling window.         |
| `EXPORT_TIMING_ALERT_REPEAT_HOURS`   | `1`     | Suppress repeat pages for the same `<route>:<reason>` for N hours.    |
| `EXPORT_TIMING_WINDOW_MAX_SAMPLES`   | `500`   | Per-route ring buffer size (caps memory).                             |
| `EXPORT_TIMING_WINDOW_MAX_AGE_MIN`   | `60`    | Drop samples older than N minutes from the rolling window.            |
| `EXPORT_TIMING_ALERT_CRON`           | `*/5 * * * *` | How often the cron tick runs.                                   |
| `EXPORT_TIMING_ALERT_DISABLED`       | unset   | Set to `1` to silence the alert without removing the cron.            |
| `EXPORT_TIMING_SLACK_WEBHOOK_URL`    | unset   | Channel webhook (falls back to `SLACK_WEBHOOK_URL`).                  |
| `EXPORT_TIMING_ALERT_EMAIL`          | unset   | Comma-separated recipient list for the Resend email.                  |

A short flap window plus a moderate `MIN_SAMPLES` is the right call for
new routes with low traffic; a longer `REPEAT_HOURS` is the right call
once a regression is acknowledged and a fix is in flight.
