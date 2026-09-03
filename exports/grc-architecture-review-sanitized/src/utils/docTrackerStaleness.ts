/**
 * docTrackerStaleness — dead-man's switch for the documentation collector.
 *
 * WHY THIS EXISTS
 * A tracker that has quietly stopped updating is WORSE than no tracker, because
 * it is trusted. The board keeps rendering yesterday's snapshot and everything
 * looks fine. "No data" must never be allowed to read as "no change".
 *
 * TWO SIGNALS, because they fail differently:
 *
 *   silent  — no HEARTBEAT for 90 minutes. The agent process is not running.
 *             This is the early warning: it catches "the service died at 09:00"
 *             about a day before the snapshot rule would.
 *   stale   — no SNAPSHOT for 26 hours (a daily push plus two hours of grace).
 *             This is the headline rule from the specification.
 *
 * A collector whose library simply has not changed still heartbeats, so a quiet
 * library and a dead agent are distinguishable — that is the whole reason the
 * heartbeat endpoint exists separately from ingest.
 *
 * DELIBERATELY NOT A CRON WORKFLOW. Registering extra workflows has crashed this
 * app at boot before (see the guardrail comment in mastra/index.ts). This hangs
 * off the existing 45-minute housekeeping loop and self-gates, exactly like
 * overdueReminders.
 *
 * Anti-spam is PER ROW (`last_alert_at`), not global: a collector is only
 * re-alerted after ~20h, which survives restarts and means a newly-registered
 * collector never re-nags about the others.
 */

import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";

/** No heartbeat for this long ⇒ the agent process is not running. */
export const SILENT_AFTER_MINUTES = 90;

/** No snapshot for this long ⇒ the board may be showing stale truth. */
export const STALE_AFTER_HOURS = 26;

/** Per-collector re-alert gate. */
export const ALERT_EVERY_HOURS = 20;

const APP_URL = process.env.APP_BASE_URL || "https://<REDACTED_HOST>";

export type CollectorHealth = "ok" | "silent" | "stale" | "disabled";

/**
 * Pure state machine. Ages are supplied by the DATABASE (see the query below,
 * which derives them from NOW()) so a skewed application clock can never make a
 * dead collector look fresh — but the DECISION lives here in plain TypeScript
 * so it can be unit-tested without a database.
 *
 * A null age means "never happened", which is treated as degraded rather than
 * healthy: a collector that has never pushed a snapshot is exactly the case
 * where the board would otherwise show an empty state and be believed.
 *
 * Order matters. `stale` outranks `silent` because a missing snapshot is the
 * headline finding; reporting "the agent is quiet" would understate a collector
 * that has been heartbeating happily for a week without ever pushing data.
 */
export function computeHealthState(input: {
  enabled: boolean;
  snapshotHours: number | null;
  heartbeatMinutes: number | null;
}): CollectorHealth {
  if (!input.enabled) return "disabled";
  if (input.snapshotHours === null || input.snapshotHours >= STALE_AFTER_HOURS) {
    return "stale";
  }
  if (
    input.heartbeatMinutes === null ||
    input.heartbeatMinutes >= SILENT_AFTER_MINUTES
  ) {
    return "silent";
  }
  return "ok";
}

/** Pure: has enough time passed since the last alert to send another? */
export function isAlertDue(lastAlertAgeHours: number | null): boolean {
  return lastAlertAgeHours === null || lastAlertAgeHours >= ALERT_EVERY_HOURS;
}

/** Pure: a degraded state is one that warrants an operator alert. */
export function isDegraded(state: CollectorHealth): boolean {
  return state === "stale" || state === "silent";
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function mail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    if (!to) return false;
    const { sendResendEmail } = await import("./resendMail");
    const r = await sendResendEmail({
      to,
      subject,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a">${html}</div>`,
    });
    return Boolean(r?.success);
  } catch (e) {
    logger.error(`[DocTrackerStaleness] send failed: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Recompute health for every collector and alert on newly-degraded ones.
 *
 * Health is derived in SQL against DB time so a skewed application clock cannot
 * make a dead collector look fresh. Idempotent: re-running without a state
 * change writes nothing and sends nothing.
 */
export async function evaluateCollectorHealth(): Promise<{
  evaluated: number;
  degraded: number;
  alerted: number;
}> {
  const { initDocTrackerTables } = await import("./docTrackerDatabase");
  await initDocTrackerTables();

  // Ages come from the DATABASE clock; the decision is made by the pure
  // functions above. That keeps NOW() authoritative (an app-server clock skew
  // must never make a dead collector look fresh) while leaving the state
  // machine unit-testable without a database.
  const rows = await pool.query(
    `SELECT collector_id,
            health_state,
            enabled,
            EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at)) / 60   AS heartbeat_minutes,
            EXTRACT(EPOCH FROM (NOW() - last_snapshot_at))  / 3600 AS snapshot_hours,
            EXTRACT(EPOCH FROM (NOW() - last_alert_at))     / 3600 AS alert_age_hours
       FROM doc_tracker_collectors`,
  );

  let degraded = 0;
  let alerted = 0;
  const notifyTo =
    process.env.DOC_TRACKER_ALERT_EMAIL || process.env.GRQ_OWNER_EMAIL || "";

  const num = (v: any): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  for (const r of rows.rows) {
    const computed = computeHealthState({
      enabled: r.enabled !== false,
      snapshotHours: num(r.snapshot_hours),
      heartbeatMinutes: num(r.heartbeat_minutes),
    });
    const current = String(r.health_state) as CollectorHealth;
    const degradedNow = isDegraded(computed);
    if (degradedNow) degraded++;

    if (computed === current && !degradedNow) continue;

    // Record the state transition. stale_since is set on entry to a degraded
    // state and cleared on recovery, so the UI can say how long it has been bad.
    await pool.query(
      `UPDATE doc_tracker_collectors
          SET health_state = $2,
              stale_since  = CASE
                               WHEN $3 THEN COALESCE(stale_since, NOW())
                               ELSE NULL
                             END,
              updated_at   = NOW()
        WHERE collector_id = $1`,
      [r.collector_id, computed, degradedNow],
    );

    // Alert only on a degraded state, and only once per ALERT_EVERY_HOURS.
    if (!degradedNow || !isAlertDue(num(r.alert_age_hours))) continue;

    // Stamp BEFORE sending so a mail failure cannot produce a retry storm on
    // the 45-minute loop.
    await pool.query(
      `UPDATE doc_tracker_collectors SET last_alert_at = NOW() WHERE collector_id = $1`,
      [r.collector_id],
    );

    const detail =
      computed === "stale"
        ? `has not pushed a snapshot for ${Math.round(Number(r.snapshot_hours) || 0)} hour(s)`
        : `has not sent a heartbeat for ${Math.round(Number(r.heartbeat_minutes) || 0)} minute(s)`;

    logger.warn(
      `⚠️ [DocTrackerStaleness] collector '${r.collector_id}' is ${computed} — ${detail}`,
    );

    if (notifyTo) {
      const ok = await mail(
        notifyTo,
        `Documentation Tracker: collector '${r.collector_id}' is ${computed}`,
        `<p><strong>The documentation collector '${esc(r.collector_id)}' ${esc(detail)}.</strong></p>
         <p>The Documentation Live Tracker is still displaying its last snapshot. That data is not necessarily wrong, but it is <em>not confirmed current</em> — treat the board as unverified until the collector reports again.</p>
         <p>Check that the collector service is running on the file server and that the library share is mounted.</p>
         <p><a href="${esc(APP_URL)}/documentation-tracker">Open the Documentation Live Tracker</a></p>`,
      );
      if (ok) alerted++;
    }
  }

  return { evaluated: rows.rows.length, degraded, alerted };
}

/**
 * Housekeeping-loop entry point.
 *
 * Runs on every 45-minute tick — unlike the reminder helpers there is no time
 * window, because a collector can die at any hour and the 90-minute silent
 * threshold would be meaningless if only checked once a day. The per-row 20h
 * alert gate is what stops the loop re-sending.
 *
 * Returns the shape the loop expects; `ran` is true only when something was
 * actually degraded, so a healthy fleet stays silent in the logs.
 */
export async function runCollectorHealthCheckIfDue(): Promise<{
  ran: boolean;
  ageHours: number;
}> {
  try {
    const { degraded, alerted } = await evaluateCollectorHealth();
    return { ran: degraded > 0 || alerted > 0, ageHours: 1 };
  } catch (err) {
    logger.error("[DocTrackerStaleness] health check failed:", err);
    return { ran: false, ageHours: 0 };
  }
}
