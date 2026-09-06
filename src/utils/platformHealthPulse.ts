/**
 * Platform Health Pulse
 *
 * Runs a battery of shape-and-freshness assertions against critical platform
 * data and endpoints every 15 minutes (via Inngest cron). Each check returns
 * pass / warn / fail. A failing check fires a high-priority notification so
 * regressions surface within minutes rather than days.
 *
 * Add new checks by appending to the CHECKS array. Each check must:
 *   - have a unique `id`
 *   - return `{ status, message?, details? }`
 *   - swallow its own errors (return status='fail') — never throw
 *
 * Results persist in `health_pulse_runs` (one row per run) for trending.
 */

import pg from "pg";
import { logger } from "./logger";
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SELF_BASE_URL =
  process.env.HEALTH_PULSE_BASE_URL ||
  process.env.SELF_BASE_URL ||
  `http://localhost:${process.env.PORT || "5000"}`;

export type CheckStatus = "pass" | "warn" | "fail" | "skipped";

export interface CheckResult {
  id: string;
  label: string;
  category: string;
  status: CheckStatus;
  message?: string;
  details?: any;
  duration_ms: number;
}

export interface PulseRun {
  id?: number;
  run_at: Date;
  overall_status: "healthy" | "degraded" | "critical";
  pass_count: number;
  warn_count: number;
  fail_count: number;
  skipped_count: number;
  duration_ms: number;
  checks: CheckResult[];
}

export async function initHealthPulseTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS health_pulse_runs (
      id SERIAL PRIMARY KEY,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      overall_status VARCHAR(20) NOT NULL,
      pass_count INTEGER NOT NULL DEFAULT 0,
      warn_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      checks JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_health_pulse_runs_run_at ON health_pulse_runs(run_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_health_pulse_runs_status ON health_pulse_runs(overall_status)`,
  );
}

/* ------------------------------------------------------------------------- */
/* Individual checks                                                          */
/* ------------------------------------------------------------------------- */

type Check = {
  id: string;
  label: string;
  category: string;
  run: () => Promise<
    Omit<CheckResult, "id" | "label" | "category" | "duration_ms">
  >;
};

/** Hours without a new audit event before the trail is treated as suspect. */
export const AUDIT_WRITE_WARN_HOURS = 72;
/** Hours without a new audit event before it is treated as stopped. */
export const AUDIT_WRITE_FAIL_HOURS = 168;

/**
 * Grade the age of the newest `event_logs` row.
 *
 * Exported and pure so the thresholds are testable without a database — the
 * boundaries are the only judgement in this check, and getting them wrong is
 * either alert spam or another silent outage.
 *
 * 72h absorbs a long weekend on a quiet platform. 168h does not: the 2026-08
 * outage ran to eighteen days, so it trips `fail` on day seven and reaches
 * Slack, rather than sitting unseen.
 */
export function classifyAuditWriteRecency(hoursOld: number): {
  status: "pass" | "warn" | "fail";
  message?: string;
} {
  const days = (hoursOld / 24).toFixed(1);
  if (hoursOld > AUDIT_WRITE_FAIL_HOURS) {
    return {
      status: "fail",
      message: `No audit event recorded for ${days} days — the audit trail has almost certainly stopped`,
    };
  }
  if (hoursOld > AUDIT_WRITE_WARN_HOURS) {
    return {
      status: "warn",
      message: `Newest audit event is ${days} days old`,
    };
  }
  return { status: "pass" };
}

const CHECKS: Check[] = [
  {
    id: "db_connectivity",
    label: "Database connectivity",
    category: "infrastructure",
    run: async () => {
      const r = await pool.query("SELECT 1 AS ok");
      return r.rows[0]?.ok === 1
        ? { status: "pass" }
        : { status: "fail", message: "DB returned unexpected result" };
    },
  },
  {
    // The AUDIT TRAIL itself (event_logs), not the quality audits below.
    //
    // logEvent() catches every write error, records it, and returns null — the
    // action still succeeds, so a caller sees 200 whether or not the event was
    // recorded. That state was only visible by manually opening
    // /api/logs/stats, which is how eighteen days of audit history went missing
    // before anyone noticed (see the comments in eventLogsDatabase.ts).
    //
    // Reports `fail`, never `warn`, when writes are broken: only a failing
    // check makes the run "critical", and only a critical run is dispatched at
    // `high` priority — which is the sole path that reaches Slack/email.
    // A "degraded" run notifies in-app only, and the in-app hub feed currently
    // has no reachable reader.
    //
    // Two independent signals, because neither alone is sufficient:
    //   in-process — exact error, but only for THIS instance and only since
    //                the last restart.
    //   recency    — survives restarts and covers every instance, and is what
    //                would actually have caught the eighteen-day gap.
    id: "audit_write_health",
    label: "Audit trail writes succeeding (event_logs)",
    category: "infrastructure",
    run: async () => {
      const { getAuditWriteHealth } = await import("./eventLogsDatabase");
      const health = getAuditWriteHealth();
      if (!health.healthy && health.lastFailure) {
        return {
          status: "fail",
          message:
            `Audit writes are FAILING (since ${health.lastFailure.at}): ` +
            `${health.lastFailure.message}. Actions are still being applied but ` +
            `are not being recorded.`,
          details: health.lastFailure,
        };
      }

      // Uses idx_event_logs_created_at (DESC) — a single index read per
      // partition, not a scan.
      const r = await pool.query(
        `SELECT EXTRACT(EPOCH FROM (NOW() - created_at))/3600 AS hours_old
           FROM event_logs ORDER BY created_at DESC LIMIT 1`,
      );
      if (r.rows.length === 0) {
        return {
          status: "fail",
          message: "event_logs is EMPTY — no audit event has ever been recorded",
        };
      }
      const hours = parseFloat(r.rows[0].hours_old);
      return {
        ...classifyAuditWriteRecency(hours),
        details: { hoursOld: hours },
      };
    },
  },
  {
    id: "audit_recency",
    label: "Latest audit recency (< 8 days)",
    category: "audits",
    run: async () => {
      const r = await pool.query(
        `SELECT id, created_at, EXTRACT(EPOCH FROM (NOW() - created_at))/3600 AS hours_old
         FROM quality_audit_results ORDER BY created_at DESC LIMIT 1`,
      );
      if (r.rows.length === 0) {
        return { status: "fail", message: "No audits have ever been recorded" };
      }
      const hours = parseFloat(r.rows[0].hours_old);
      const auditId = r.rows[0].id;
      if (hours > 192) {
        return {
          status: "fail",
          message: `Latest audit (id ${auditId}) is ${hours.toFixed(1)}h old; cron may be broken`,
          details: { auditId, hoursOld: hours },
        };
      }
      if (hours > 168) {
        return {
          status: "warn",
          message: `Latest audit (id ${auditId}) is ${hours.toFixed(1)}h old`,
          details: { auditId, hoursOld: hours },
        };
      }
      return { status: "pass", details: { auditId, hoursOld: hours } };
    },
  },
  {
    id: "audit_module_coverage",
    label: "Latest audit covers all expected modules",
    category: "audits",
    run: async () => {
      // The exact bug we lived with for 5 days: audit had 1000 rows but
      // 100% Leads. This check would have caught it on day 1.
      const expected = ["Leads", "Deals", "Contacts", "Accounts"];
      const r = await pool.query(
        `SELECT id, raw_audit_data FROM quality_audit_results
         ORDER BY created_at DESC LIMIT 1`,
      );
      if (r.rows.length === 0) {
        return { status: "skipped", message: "No audit to inspect" };
      }
      const auditId = r.rows[0].id;
      const raw = r.rows[0].raw_audit_data || {};
      const issues: any[] = Array.isArray(raw.all_issues) ? raw.all_issues : [];

      // Tolerate older audits that didn't persist all_issues at all.
      if (issues.length === 0) {
        return {
          status: "warn",
          message: `Audit ${auditId} has no all_issues array (legacy format)`,
          details: { auditId },
        };
      }

      const moduleCounts: Record<string, number> = {};
      for (const issue of issues) {
        const m = issue.module || issue.zoho_module || "unknown";
        moduleCounts[m] = (moduleCounts[m] || 0) + 1;
      }
      const present = Object.keys(moduleCounts);
      const missing = expected.filter((m) => !(m in moduleCounts));

      if (missing.length >= 3) {
        return {
          status: "fail",
          message: `Audit ${auditId} only covers ${present.length} module(s): ${present.join(", ")}. Missing ${missing.join(", ")}.`,
          details: { auditId, moduleCounts, missing },
        };
      }
      if (missing.length > 0) {
        return {
          status: "warn",
          message: `Audit ${auditId} missing modules: ${missing.join(", ")}`,
          details: { auditId, moduleCounts, missing },
        };
      }
      return {
        status: "pass",
        details: { auditId, moduleCounts },
      };
    },
  },
  {
    id: "audit_no_synthetic_rows",
    label: "Latest audit contains no synthetic summary_* rows",
    category: "audits",
    run: async () => {
      const r = await pool.query(
        `SELECT id, raw_audit_data FROM quality_audit_results
         ORDER BY created_at DESC LIMIT 1`,
      );
      if (r.rows.length === 0) return { status: "skipped" };
      const auditId = r.rows[0].id;
      const raw = r.rows[0].raw_audit_data || {};
      const issues: any[] = Array.isArray(raw.all_issues) ? raw.all_issues : [];
      const synthetic = issues.filter(
        (i) =>
          typeof i.record_id === "string" && i.record_id.startsWith("summary_"),
      );
      if (synthetic.length > 0) {
        return {
          status: "fail",
          message: `Audit ${auditId} contains ${synthetic.length} synthetic summary_* rows — silent fallback active`,
          details: { auditId, syntheticCount: synthetic.length },
        };
      }
      return { status: "pass", details: { auditId } };
    },
  },
  {
    id: "duplicate_radar_freshness",
    label: "Duplicate Radar scan recency (< 12h)",
    category: "duplicates",
    run: async () => {
      const r = await pool.query(
        `SELECT MAX(updated_at) AS last_run,
                COUNT(*) FILTER (WHERE status = 'active') AS clusters
         FROM duplicate_clusters`,
      );
      const lastRun: Date | null = r.rows[0]?.last_run;
      const clusters = parseInt(r.rows[0]?.clusters || "0");
      if (!lastRun) {
        return {
          status: "warn",
          message: "Duplicate Radar has never run",
        };
      }
      const hours = (Date.now() - new Date(lastRun).getTime()) / 3600000;
      if (hours > 24) {
        return {
          status: "fail",
          message: `Duplicate Radar last scan was ${hours.toFixed(1)}h ago (cron should run every 6h)`,
          details: { hoursOld: hours, clusters },
        };
      }
      if (hours > 12) {
        return {
          status: "warn",
          message: `Duplicate Radar last scan was ${hours.toFixed(1)}h ago`,
          details: { hoursOld: hours, clusters },
        };
      }
      return { status: "pass", details: { hoursOld: hours, clusters } };
    },
  },
  {
    id: "ai_approval_queue_depth",
    label: "HITL approval queue depth (< 50 pending)",
    category: "ai",
    run: async () => {
      const r = await pool.query(
        `SELECT COUNT(*) AS pending FROM ai_pending_actions WHERE status = 'pending'`,
      );
      const pending = parseInt(r.rows[0]?.pending || "0");
      if (pending > 100) {
        return {
          status: "fail",
          message: `${pending} pending AI approvals — queue is overflowing`,
          details: { pending },
        };
      }
      if (pending > 50) {
        return {
          status: "warn",
          message: `${pending} pending AI approvals — review queue`,
          details: { pending },
        };
      }
      return { status: "pass", details: { pending } };
    },
  },
  {
    id: "ai_approval_stale",
    label: "No HITL approvals stale > 4h",
    category: "ai",
    run: async () => {
      const r = await pool.query(
        `SELECT COUNT(*) AS stale FROM ai_pending_actions
         WHERE status = 'pending' AND created_at < NOW() - INTERVAL '4 hours'`,
      );
      const stale = parseInt(r.rows[0]?.stale || "0");
      if (stale > 5) {
        return {
          status: "fail",
          message: `${stale} HITL approvals waiting > 4h — reviewers asleep at the wheel`,
          details: { stale },
        };
      }
      if (stale > 0) {
        return {
          status: "warn",
          message: `${stale} HITL approval(s) waiting > 4h`,
          details: { stale },
        };
      }
      return { status: "pass", details: { stale: 0 } };
    },
  },
  {
    id: "kpi_freshness",
    label: "KPI values calculated in last 26h",
    category: "kpis",
    run: async () => {
      const r = await pool.query(
        `SELECT MAX(created_at) AS last_calc, COUNT(*) AS total FROM kpi_values`,
      );
      const last: Date | null = r.rows[0]?.last_calc;
      const total = parseInt(r.rows[0]?.total || "0");
      if (!last) {
        return {
          status: "warn",
          message: "No KPI values have ever been recorded",
        };
      }
      const hours = (Date.now() - new Date(last).getTime()) / 3600000;
      if (hours > 48) {
        return {
          status: "fail",
          message: `Last KPI calculation was ${hours.toFixed(1)}h ago (daily cron should run nightly)`,
          details: { hoursOld: hours, total },
        };
      }
      if (hours > 26) {
        return {
          status: "warn",
          message: `Last KPI calculation was ${hours.toFixed(1)}h ago`,
          details: { hoursOld: hours, total },
        };
      }
      return { status: "pass", details: { hoursOld: hours, total } };
    },
  },
  {
    id: "endpoint_audit_latest",
    label: "/api/audit/latest returns valid shape",
    category: "endpoints",
    run: async () => {
      const adminKey = process.env.ADMIN_API_KEY;
      if (!adminKey) {
        return { status: "skipped", message: "ADMIN_API_KEY not configured" };
      }
      const res = await fetch(`${SELF_BASE_URL}/api/audit/latest`, {
        headers: { "X-Admin-Key": adminKey },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return {
          status: "fail",
          message: `HTTP ${res.status}`,
          details: { status: res.status },
        };
      }
      const body: any = await res.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return { status: "fail", message: "Response is not JSON" };
      }
      // Accept a number of plausible top-level shapes; the bug we care about is
      // the response existing but being structurally empty.
      const hasContent =
        Array.isArray(body.audits) ||
        Array.isArray(body.all_issues) ||
        body.id !== undefined ||
        body.audit_date !== undefined ||
        body.overall_score !== undefined;
      if (!hasContent) {
        return {
          status: "fail",
          message: "Endpoint returned 200 but response is empty/unrecognized",
          details: { keys: Object.keys(body) },
        };
      }
      return {
        status: "pass",
        details: { keys: Object.keys(body).slice(0, 8) },
      };
    },
  },
  {
    id: "rate_limit_429_pruner_freshness",
    label: "rate_limit_429 pruner running (no rows older than retention + 1h)",
    category: "infrastructure",
    run: async () => {
      const retentionHours = (() => {
        const raw = process.env.RATE_LIMIT_429_RETENTION_HOURS;
        const parsed = parseInt(raw ?? "24", 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
      })();
      const thresholdHours = retentionHours + 1;
      try {
        const r = await pool.query<{ hours: number | null; count: string }>(
          `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))/3600 AS hours,
                  COUNT(*)::text AS count
           FROM system_events
           WHERE event_type = 'rate_limit_429'`,
        );
        const row = r.rows[0];
        const oldestHours = row?.hours == null ? null : Number(row.hours);
        const totalCount = parseInt(row?.count ?? "0", 10);
        if (oldestHours === null) {
          return {
            status: "pass",
            message: "No rate_limit_429 rows exist — nothing to prune",
            details: { totalCount: 0, retentionHours, thresholdHours },
          };
        }
        if (oldestHours > thresholdHours) {
          return {
            status: "fail",
            message: `Oldest rate_limit_429 row is ${oldestHours.toFixed(1)}h old (retention=${retentionHours}h + 1h grace). Pruner cron may be broken.`,
            details: {
              oldestHours,
              totalCount,
              retentionHours,
              thresholdHours,
            },
          };
        }
        if (oldestHours > retentionHours) {
          return {
            status: "warn",
            message: `Oldest rate_limit_429 row is ${oldestHours.toFixed(1)}h old (within 1h grace period — pruner should run soon)`,
            details: {
              oldestHours,
              totalCount,
              retentionHours,
              thresholdHours,
            },
          };
        }
        return {
          status: "pass",
          details: { oldestHours, totalCount, retentionHours },
        };
      } catch (err: any) {
        return {
          status: "fail",
          message: `DB error checking rate_limit_429 pruner freshness: ${err?.message}`,
        };
      }
    },
  },
  {
    id: "endpoint_health",
    label: "/api/health returns ok",
    category: "endpoints",
    run: async () => {
      const res = await fetch(`${SELF_BASE_URL}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { status: "fail", message: `HTTP ${res.status}` };
      const body: any = await res.json().catch(() => null);
      if (body?.status !== "ok") {
        return {
          status: "fail",
          message: "status field is not 'ok'",
          details: body,
        };
      }
      return { status: "pass" };
    },
  },
];

/* ------------------------------------------------------------------------- */
/* Runner                                                                     */
/* ------------------------------------------------------------------------- */

export async function runHealthPulse(): Promise<PulseRun> {
  const startedAt = Date.now();
  const results: CheckResult[] = [];

  for (const check of CHECKS) {
    const t0 = Date.now();
    try {
      const r = await check.run();
      results.push({
        id: check.id,
        label: check.label,
        category: check.category,
        status: r.status,
        message: r.message,
        details: r.details,
        duration_ms: Date.now() - t0,
      });
    } catch (err: any) {
      results.push({
        id: check.id,
        label: check.label,
        category: check.category,
        status: "fail",
        message: `Uncaught error: ${err?.message || String(err)}`,
        duration_ms: Date.now() - t0,
      });
    }
  }

  const passCount = results.filter((r) => r.status === "pass").length;
  const warnCount = results.filter((r) => r.status === "warn").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  const skippedCount = results.filter((r) => r.status === "skipped").length;

  const overall: PulseRun["overall_status"] =
    failCount > 0 ? "critical" : warnCount > 0 ? "degraded" : "healthy";

  const run: PulseRun = {
    run_at: new Date(),
    overall_status: overall,
    pass_count: passCount,
    warn_count: warnCount,
    fail_count: failCount,
    skipped_count: skippedCount,
    duration_ms: Date.now() - startedAt,
    checks: results,
  };

  try {
    const persisted = await pool.query(
      `INSERT INTO health_pulse_runs
       (run_at, overall_status, pass_count, warn_count, fail_count, skipped_count, duration_ms, checks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        run.run_at,
        run.overall_status,
        run.pass_count,
        run.warn_count,
        run.fail_count,
        run.skipped_count,
        run.duration_ms,
        JSON.stringify(run.checks),
      ],
    );
    run.id = persisted.rows[0]?.id;
  } catch (err: any) {
    logger.error("[HealthPulse] Failed to persist run:", err?.message);
  }

  return run;
}

/**
 * Fire a notification for a degraded/critical pulse run. Suppresses repeated
 * alerts: only fires when the most recent prior run had a different status.
 */
/**
 * Stable identity for "what is currently wrong", used to decide whether a pulse
 * is worth announcing.
 *
 * Sorted so check ordering cannot manufacture a spurious change, and scoped to
 * fail/warn ids only: a check flipping pass→pass is not news, and the message
 * text is deliberately excluded because counts drift ("281 pending" vs "280")
 * without the situation actually changing.
 */
export function problemSignature(
  checks: Array<{ id?: string; status?: string }> | null | undefined,
): string {
  if (!Array.isArray(checks)) return "";
  return checks
    .filter((c) => c && (c.status === "fail" || c.status === "warn"))
    .map((c) => `${c.status}:${c.id ?? "?"}`)
    .sort()
    .join(",");
}

/** `checks` comes back as jsonb (already an array) or as text, depending on the driver. */
function parsePersistedChecks(raw: unknown): Array<{ id?: string; status?: string }> {
  if (Array.isArray(raw)) return raw as Array<{ id?: string; status?: string }>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export async function maybeNotifyOnPulse(run: PulseRun): Promise<void> {
  if (run.overall_status === "healthy") return;

  // De-duplicate on the overall status AND on WHICH checks are unhappy.
  //
  // Comparing the status alone was not enough. A platform that stays
  // "critical" — which is exactly what a queue nobody drains or a cron that
  // stopped produces — matches its predecessor on every subsequent run, so it
  // alerts once and then goes quiet forever, including for a completely
  // different failure appearing later. The louder the platform's problems, the
  // more thoroughly it would hide new ones.
  //
  // Comparing the SET of failing/warning check ids as well means a steady state
  // stays silent (no spam) while anything newly broken still gets announced.
  try {
    const prev = run.id
      ? await pool.query(
          `SELECT overall_status, checks FROM health_pulse_runs
           WHERE id < $1 ORDER BY id DESC LIMIT 1`,
          [run.id],
        )
      : await pool.query(
          `SELECT overall_status, checks FROM health_pulse_runs
           ORDER BY id DESC LIMIT 1`,
        );
    const prevRow = prev.rows[0];
    if (
      prevRow?.overall_status === run.overall_status &&
      problemSignature(parsePersistedChecks(prevRow.checks)) ===
        problemSignature(run.checks)
    ) {
      return;
    }
  } catch {}

  const failedChecks = run.checks.filter((c) => c.status === "fail");
  const warnedChecks = run.checks.filter((c) => c.status === "warn");

  const summaryLines: string[] = [];
  if (failedChecks.length > 0) {
    summaryLines.push("FAILING:");
    for (const c of failedChecks) {
      summaryLines.push(`  - ${c.label}: ${c.message || "(no details)"}`);
    }
  }
  if (warnedChecks.length > 0) {
    summaryLines.push("WARNINGS:");
    for (const c of warnedChecks) {
      summaryLines.push(`  - ${c.label}: ${c.message || "(no details)"}`);
    }
  }

  try {
    const { notifyEvent } = await import("./notificationHub");
    await notifyEvent({
      type: "platform_health_alert",
      module: "platform",
      title: `Platform Health: ${run.overall_status.toUpperCase()} (${run.fail_count} fail, ${run.warn_count} warn)`,
      message: summaryLines.join("\n"),
      // "high" for BOTH states, not just critical. notifyEvent only extends to
      // Slack/email at critical|high; a "degraded" run sent at "medium" went
      // in-app only, and the in-app hub feed has no reachable reader — so every
      // warning this pulse has ever raised was discarded silently.
      //
      // This function already fires only on a status TRANSITION (see the
      // de-duplication above), so raising the level cannot turn into repeat
      // alert spam on a persistently degraded platform.
      priority: "high",
      entityType: "health_pulse_run",
      entityId: String(run.id || ""),
      actionUrl: "/api/health/pulse",
    });
  } catch (err: any) {
    logger.error(
      "[HealthPulse] Failed to dispatch notification:",
      err?.message,
    );
  }
}

export async function getRecentPulseRuns(limit = 50): Promise<PulseRun[]> {
  const r = await pool.query(
    `SELECT id, run_at, overall_status, pass_count, warn_count, fail_count,
            skipped_count, duration_ms, checks
     FROM health_pulse_runs ORDER BY run_at DESC LIMIT $1`,
    [limit],
  );
  return r.rows.map((row) => ({
    id: row.id,
    run_at: row.run_at,
    overall_status: row.overall_status,
    pass_count: row.pass_count,
    warn_count: row.warn_count,
    fail_count: row.fail_count,
    skipped_count: row.skipped_count,
    duration_ms: row.duration_ms,
    checks: row.checks,
  }));
}

export async function getLatestPulseRun(): Promise<PulseRun | null> {
  const runs = await getRecentPulseRuns(1);
  return runs[0] || null;
}

export interface PerCheckHistoryEntry {
  run_at: Date;
  status: CheckStatus;
}

/**
 * Collapse a list of recent pulse runs into a per-check status history,
 * keyed by check id. Entries are returned in chronological order
 * (oldest first → newest last) so callers can render a left-to-right
 * sparkline directly. The most recent `limitPerCheck` entries are kept
 * for each check id; older entries are dropped.
 *
 * Tolerates legacy rows whose `checks` payload is missing or malformed —
 * those runs simply contribute no entries.
 */
export function buildPerCheckHistory(
  runs: PulseRun[],
  limitPerCheck = 30,
): Record<string, PerCheckHistoryEntry[]> {
  const ordered = [...runs].reverse();
  const perCheck: Record<string, PerCheckHistoryEntry[]> = {};

  for (const run of ordered) {
    const checks = Array.isArray(run.checks) ? run.checks : [];
    for (const c of checks) {
      if (!c || typeof c.id !== "string" || !c.id) continue;
      const status: CheckStatus =
        c.status === "pass" || c.status === "warn" ||
        c.status === "fail" || c.status === "skipped"
          ? c.status
          : "skipped";
      (perCheck[c.id] = perCheck[c.id] || []).push({
        run_at: run.run_at,
        status,
      });
    }
  }

  for (const id of Object.keys(perCheck)) {
    const entries = perCheck[id];
    if (entries.length > limitPerCheck) {
      perCheck[id] = entries.slice(entries.length - limitPerCheck);
    }
  }

  return perCheck;
}
