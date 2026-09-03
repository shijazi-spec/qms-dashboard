import pg from "pg";
import pino from "pino";

import { logger } from "./logger";
const { Pool } = pg;

const rlLogger = pino({ level: "warn", name: "rateLimiter" });

let rlPool: InstanceType<typeof Pool> | null = null;
let failOpenCount = 0;

function getPool(): InstanceType<typeof Pool> {
  if (!rlPool) {
    rlPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return rlPool;
}

const WINDOW_MS = 60 * 1000;
const SUB_BUCKET_MS = 1000;
const READ_LIMIT = 100;
// Authenticated per-user write budget/minute. 10 was far too tight for normal
// interactive editing (ticking a checklist, quick edits) and produced constant
// "Too many requests" 429s during legitimate work. Bumped to 60 (≈1/sec) — still
// per-authenticated-user so abuse stays bounded to one operator's own data.
// Override with RATE_LIMIT_WRITE_PER_MIN if a deployment needs to tune it.
const WRITE_LIMIT = (() => {
  const raw = parseInt(process.env.RATE_LIMIT_WRITE_PER_MIN ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
})();
const AUTH_LIMIT = 5;
const EXPORT_LIMIT = 10;
const AUDIO_LIMIT = 20;
const UNAUTH_READ_LIMIT = 10;
const UNAUTH_WRITE_LIMIT = 3;

/**
 * Documentation Live Tracker collector budget.
 *
 * The collector's three endpoints are in PUBLIC_PATHS (they self-authenticate
 * with X-Tracker-Key because the caller is a Windows service, not a browser),
 * which means the limiter would otherwise treat them as UNAUTHENTICATED writes
 * at 3/min per IP. A file-watcher push plus a heartbeat plus one retry blows
 * through that immediately, and several collectors behind one office NAT share
 * the same ip: bucket.
 *
 * A dedicated category rather than a bypass: the limiter runs BEFORE the
 * handler, so a blanket exemption on an unauthenticated write path would let an
 * attacker with a bad key reach the body parser on every request. 30/min covers
 * a 5-minute cadence with retries and still caps a flood.
 */
const TRACKER_LIMIT = (() => {
  const raw = parseInt(process.env.RATE_LIMIT_DOC_TRACKER_PER_MIN ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
})();

const DOC_TRACKER_PATHS = [
  "/api/documentation-tracker/ingest",
  "/api/documentation-tracker/heartbeat",
  "/api/documentation-tracker/collector-config",
];

const AUTH_PATHS = [
  "/api/auth/",
  "/api/invitations/accept",
  "/login",
  "/api/admin/auth",
];
const EXPORT_PATHS = ["/export", "/pdf"];
// Audio download path: /api/calls/:id/audio — large binary responses warrant
// a tighter per-user cap independent of the general READ_LIMIT.
const AUDIO_PATH_PATTERN = /^\/api\/calls\/\d+\/audio$/;

/**
 * Boot-time guard: refuse to start the server if RATE_LIMIT_DISABLED is left
 * set to "true" in a production deploy. Without this, a stray dev-only env
 * var carried into production silently disables every per-IP / per-user limit
 * (see checkRateLimit() below — the disabled branch returns `{ allowed: true }`
 * unconditionally), removing DoS and brute-force protection without any
 * observable signal. Wired into src/mastra/index.ts so the failure happens
 * before any HTTP route is bound, not on the first abusive request.
 */
export function assertRateLimitEnabledInProductionOrThrow(): void {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.RATE_LIMIT_DISABLED === "true"
  ) {
    throw new Error(
      "RATE_LIMIT_DISABLED=true is not permitted in production. " +
        "Unset the variable or set it to anything other than 'true'.",
    );
  }
}

let tableReady: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      try {
        await getPool().query(`
          CREATE TABLE IF NOT EXISTS rate_limit_buckets (
            key TEXT NOT NULL,
            window_start TIMESTAMPTZ NOT NULL,
            count INT NOT NULL DEFAULT 0,
            PRIMARY KEY (key, window_start)
          );
          CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_window_start
            ON rate_limit_buckets(window_start);
        `);
      } catch (err) {
        tableReady = null;
        throw err;
      }
    })();
  }
  return tableReady;
}

ensureTable().catch((err) => {
  rlLogger.warn(
    { err, component: "rateLimiter" },
    "rate_limit_buckets table setup failed at startup — rate limiter will fail-open until DB is reachable",
  );
});

function getCategory(path?: string): string {
  if (path) {
    // Checked first: these are PUBLIC_PATHS entries, so without their own
    // category they would fall through to the 3/min unauthenticated write cap.
    if (DOC_TRACKER_PATHS.includes(path.split("?")[0])) return "doc-tracker";
    if (AUTH_PATHS.some((p) => path.startsWith(p) || path.includes(p)))
      return "auth";
    // Audio downloads are large binary responses; use a tighter dedicated limit
    // (AUDIO_LIMIT) rather than the general READ_LIMIT to bound the number of
    // concurrent large-file allocations a single user can trigger per minute.
    if (AUDIO_PATH_PATTERN.test(path.split("?")[0])) return "audio";
    if (EXPORT_PATHS.some((p) => path.includes(p))) {
      // Sibling `/estimate` endpoints (e.g. `/api/duplicates/export/estimate`)
      // are cheap COUNT(*) preflights used by streaming-download.js to show
      // an "≈ X MB" size hint on export buttons. Every Export click sends
      // BOTH the estimate and the actual download, so counting estimates
      // against EXPORT_LIMIT (10/min) cuts the user's effective click
      // budget in half — and with per-tab Export CSV buttons on the
      // duplicates dashboard that produces unexpected 429s after only a
      // handful of clicks. Treat estimate preflights as ordinary reads
      // (READ_LIMIT=100/min); the real export download is still
      // export-limited, which is what protects the heavy streaming path.
      if (path.endsWith("/estimate") || path.includes("/estimate?")) {
        return "general";
      }
      return "export";
    }
  }
  return "general";
}

const TRUST_PROXY_HOPS = (() => {
  const raw = process.env.TRUST_PROXY_HOPS;
  const parsed = parseInt(raw ?? "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
})();

function isValidOctet(s: string): boolean {
  if (!/^\d{1,3}$/.test(s)) return false;
  const n = parseInt(s, 10);
  return n >= 0 && n <= 255;
}

function sanitizeIp(raw: string): string {
  const t = raw.trim();
  // IPv4-mapped IPv6 (e.g. ::ffff:<REDACTED_IP>) — normalize to IPv4 tail
  const v4mapped = t.match(/^[a-fA-F0-9:]+:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (v4mapped && v4mapped[1].split(".").every(isValidOctet))
    return v4mapped[1];
  // Pure IPv4 — validate all four octets
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(t) && t.split(".").every(isValidOctet))
    return t;
  // IPv6 — must contain ≥ 2 colons (rules out plain hex strings like "deadbeef")
  if (/^[a-fA-F0-9:]+$/.test(t) && (t.match(/:/g) ?? []).length >= 2) return t;
  return "invalid";
}

/**
 * Resolve the real client IP with strict trust-boundary enforcement.
 *
 * Priority order:
 *  1. X-Real-IP — only when TRUST_PROXY_HOPS > 0 (a trusted proxy is declared).
 *     With TRUST_PROXY_HOPS=0 (default) X-Real-IP is untrusted and skipped.
 *  2. XFF — index ips[max(0, len - TRUST_PROXY_HOPS - 1)]:
 *     - HOPS=0: rightmost entry (direct proxy's append, safest without declared intermediates)
 *     - HOPS=1: second-from-right (the entry before the one trusted intermediate proxy added)
 *     - HOPS=N: skip N entries from right to reach the verified client IP
 *     Attacker-prepended fakes land left of the selected index and are ignored.
 *  3. 'unknown' if no valid IP can be extracted.
 *
 * IPv4-mapped IPv6 (e.g. ::ffff:<REDACTED_IP>) is normalized to IPv4.
 * TRUST_PROXY_HOPS env var (default 0) must not exceed the count of proxies you control.
 */
export function parseClientIp(
  xForwardedFor: string | undefined,
  xRealIp: string | undefined,
): string {
  if (TRUST_PROXY_HOPS > 0 && xRealIp) {
    const s = sanitizeIp(xRealIp);
    if (s !== "invalid") return s;
  }
  if (xForwardedFor) {
    const ips = xForwardedFor
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ips.length > 0) {
      const idx = Math.max(0, ips.length - TRUST_PROXY_HOPS - 1);
      const s = sanitizeIp(ips[idx]);
      if (s !== "invalid") return s;
    }
  }
  return "unknown";
}

export async function checkRateLimit(
  ip: string,
  isWrite: boolean,
  path?: string,
  isAuthenticated: boolean = true,
  userId?: string,
): Promise<{ allowed: boolean; retryAfter?: number }> {
  if (process.env.RATE_LIMIT_DISABLED === "true") {
    return { allowed: true };
  }
  const category = getCategory(path);

  const identifier = userId && isAuthenticated ? `user:${userId}` : `ip:${ip}`;
  const authPrefix = isAuthenticated ? "auth" : "unauth";
  const key =
    category === "auth"
      ? `${identifier}:authflow`
      : `${identifier}:${authPrefix}:${category}:${isWrite ? "w" : "r"}`;

  let limit: number;
  if (category === "auth") {
    limit = AUTH_LIMIT;
  } else if (category === "export") {
    limit = EXPORT_LIMIT;
  } else if (category === "audio") {
    limit = AUDIO_LIMIT;
  } else if (category === "doc-tracker") {
    // MUST be evaluated before the !isAuthenticated branch: the collector is by
    // definition unauthenticated to the limiter (it carries a key header, not a
    // session), so falling through would cap it at UNAUTH_WRITE_LIMIT = 3/min.
    limit = TRACKER_LIMIT;
  } else if (!isAuthenticated) {
    limit = isWrite ? UNAUTH_WRITE_LIMIT : UNAUTH_READ_LIMIT;
  } else {
    limit = isWrite ? WRITE_LIMIT : READ_LIMIT;
  }

  try {
    await ensureTable();
    const pool = getPool();

    // Sliding-window enforcement, all bound to DB time so multi-instance
    // clock skew can't shift the window. Sub-bucket = 1s. Requests live in
    // their second-aligned bucket; the SELECT predicate keeps any bucket
    // whose latest possible request might still fall inside the trailing
    // 60s window. Conservative bound: window_start > NOW() - 61s admits
    // any sub-bucket [T, T+1s) whose tail (T+1s) is still ≥ NOW()-60s.
    // This errs on the side of strictness — we never undercount in-window
    // requests due to bucket-start truncation.
    await pool.query(
      `INSERT INTO rate_limit_buckets (key, window_start, count)
       VALUES ($1, date_trunc('second', NOW()), 1)
       ON CONFLICT (key, window_start)
       DO UPDATE SET count = rate_limit_buckets.count + 1`,
      [key],
    );

    const sumResult = await pool.query<{
      total: string;
      oldest_epoch: string | null;
      now_epoch: string;
    }>(
      `SELECT COALESCE(SUM(count), 0)::text AS total,
              EXTRACT(EPOCH FROM MIN(window_start))::float8::text AS oldest_epoch,
              EXTRACT(EPOCH FROM NOW())::float8::text AS now_epoch
       FROM rate_limit_buckets
       WHERE key = $1
         AND window_start > NOW() - INTERVAL '1 minute' - INTERVAL '1 second'`,
      [key],
    );

    const row = sumResult.rows[0];
    const total = parseInt(row.total, 10);
    if (total > limit) {
      const nowMs = parseFloat(row.now_epoch) * 1000;
      const oldestMs = row.oldest_epoch
        ? parseFloat(row.oldest_epoch) * 1000
        : nowMs;
      // The oldest sub-bucket [T, T+1s) ages fully out of the rolling
      // window once NOW() ≥ T + 1s + 60s. Wait at least that long.
      const retryAfter = Math.max(
        1,
        Math.ceil((oldestMs + WINDOW_MS + SUB_BUCKET_MS - nowMs) / 1000),
      );
      return { allowed: false, retryAfter };
    }
    return { allowed: true };
  } catch (err) {
    failOpenCount++;
    rlLogger.warn(
      {
        err: (err as Error).message,
        key,
        failOpenCount,
        component: "rateLimiter",
      },
      "Rate limiter DB unreachable — failing open (counter incremented)",
    );
    return { allowed: true };
  }
}

export function getFailOpenCount(): number {
  return failOpenCount;
}

export interface RateLimitTopKey {
  key: string;
  count: number;
  window_start: string;
}

export interface RateLimitSpike24hIp {
  ip: string;
  events: number;
  suppressed: number;
}

export interface RateLimitSpike24hPath {
  path: string;
  events: number;
  suppressed: number;
}

export interface RateLimitSpike24hHourBucket {
  /** ISO-8601 timestamp marking the start of the hour bucket (UTC). */
  hour: string;
  /** Number of `rate_limit_429` system_events whose `created_at` fell in that hour. */
  count: number;
}

export interface RateLimitSpike24h {
  total429: number;
  totalSuppressed: number;
  topIps: RateLimitSpike24hIp[];
  topPaths: RateLimitSpike24hPath[];
  /**
   * Per-hour 429 counts for the last 24 hours, oldest → newest. Always
   * exactly 24 entries (zero-filled via generate_series so a quiet hour
   * still shows up as a bar of height 0). Lets the dashboard render a
   * sparkline showing whether the storm is growing or already subsiding.
   */
  hourlyBuckets: RateLimitSpike24hHourBucket[];
  /**
   * Effective alert threshold (from RATE_LIMIT_429_24H_ALERT_THRESHOLD,
   * default 500). `0` means the alert is disabled. Surfaced so the
   * dashboard can render "Alert at >= N events" hint copy.
   */
  alertThreshold: number;
  /**
   * True when `total429 >= alertThreshold` AND the threshold is enabled
   * (`> 0`). Mirrors what the cron in
   * `src/utils/rateLimit429SpikeAlert.ts` will alert on, so the UI banner
   * and the system notification stay in lockstep.
   */
  alertActive: boolean;
}

export interface RateLimitStats {
  windowMs: number;
  windowStart: string;
  topKeys: RateLimitTopKey[];
  totalRows: number;
  failOpenCount: number;
  recent429Count: number;
  dbReachable: boolean;
  dbError?: string;
  spike24h?: RateLimitSpike24h;
}

const RATE_LIMIT_429_RETENTION_HOURS = (() => {
  const raw = process.env.RATE_LIMIT_429_RETENTION_HOURS;
  const parsed = parseInt(raw ?? "24", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
})();

/**
 * Delete `system_events` rows of type `rate_limit_429` that are older than
 * RATE_LIMIT_429_RETENTION_HOURS (default 24h). The Rate Limits panel only
 * looks back 5 minutes, so anything older is pure storage cost — under a real
 * 429 storm this table can grow by thousands of rows per minute.
 *
 * Returns `{ deleted, retentionHours }`. Failures are logged and never thrown
 * so the caller (cron job) can keep its own bookkeeping intact.
 */
export async function pruneRateLimit429Events(): Promise<{
  deleted: number;
  retentionHours: number;
  dbReachable: boolean;
}> {
  const retentionHours = RATE_LIMIT_429_RETENTION_HOURS;
  try {
    const pool = getPool();
    const result = await pool.query(
      `DELETE FROM system_events
        WHERE event_type = 'rate_limit_429'
          AND created_at < NOW() - ($1::int * INTERVAL '1 hour')`,
      [retentionHours],
    );
    const deleted = result.rowCount ?? 0;
    logger.info(
      `[RateLimit429Pruner] Pruned ${deleted} rate_limit_429 system_events rows older than ${retentionHours}h`,
    );
    return { deleted, retentionHours, dbReachable: true };
  } catch (err) {
    rlLogger.warn(
      { err: (err as Error).message, component: "rateLimiter" },
      "pruneRateLimit429Events failed — will retry on next cron tick",
    );
    return { deleted: 0, retentionHours, dbReachable: false };
  }
}

export async function getRateLimitStats(): Promise<RateLimitStats> {
  // The rolling window starts ~60s ago in DB time. We expose an approximate
  // wall-clock anchor for the dashboard but the actual cutoff used by the
  // SQL query is `NOW() - INTERVAL '1 minute' - INTERVAL '1 second'`, which
  // matches the enforcement query in checkRateLimit() exactly.
  const now = Date.now();
  const rollingWindowStart = new Date(now - WINDOW_MS);

  const baseStats: RateLimitStats = {
    windowMs: WINDOW_MS,
    windowStart: rollingWindowStart.toISOString(),
    topKeys: [],
    totalRows: 0,
    failOpenCount,
    recent429Count: 0,
    dbReachable: true,
  };

  try {
    await ensureTable();
    const pool = getPool();
    const recent429Promise: Promise<number> = pool
      .query<{ count: string }>(
        `SELECT COUNT(*)::bigint AS count
           FROM system_events
          WHERE event_type = 'rate_limit_429'
            AND created_at > NOW() - INTERVAL '5 minutes'`,
      )
      .then((r) => parseInt(r.rows[0]?.count ?? "0", 10))
      .catch((err: Error) => {
        rlLogger.warn(
          { err: err.message, component: "rateLimiter" },
          "system_events query failed in getRateLimitStats — defaulting recent429Count to 0",
        );
        return 0;
      });

    // 24-hour spike aggregate: global totals + top 5 IPs + top 5 paths.
    // `suppressed_in_previous_minute` lives in the JSONB metadata column and
    // may be absent on older rows, so we default it to 0 with COALESCE.
    // The top-5 IP and top-5 path slices are independent groupings — a path
    // may aggregate hits from many IPs and vice versa — so we run them as
    // separate queries and combine with the scalar totals.
    const spike24hPromise: Promise<RateLimitSpike24h> = Promise.all([
      pool.query<{ total: string; suppressed: string }>(
        `SELECT
            COUNT(*)::bigint AS total,
            SUM(COALESCE((metadata->>'suppressed_in_previous_minute')::bigint, 0))::bigint AS suppressed
           FROM system_events
          WHERE event_type = 'rate_limit_429'
            AND created_at > NOW() - INTERVAL '24 hours'`,
      ),
      // Per-hour bucket counts for the last 24 hours. `generate_series`
      // zero-fills quiet hours so the dashboard sparkline always has
      // exactly 24 evenly-spaced points to plot regardless of traffic.
      pool.query<{ hour: Date; count: string }>(
        `WITH hours AS (
           SELECT generate_series(
             date_trunc('hour', NOW()) - INTERVAL '23 hours',
             date_trunc('hour', NOW()),
             INTERVAL '1 hour'
           ) AS hour
         )
         SELECT h.hour AS hour,
                COUNT(se.event_type)::bigint AS count
           FROM hours h
           LEFT JOIN system_events se
             ON se.event_type = 'rate_limit_429'
            AND date_trunc('hour', se.created_at) = h.hour
          GROUP BY h.hour
          ORDER BY h.hour ASC`,
      ),
      pool.query<{ ip: string; events: string; suppressed: string }>(
        `SELECT
            COALESCE(metadata->>'ip', 'unknown')           AS ip,
            COUNT(*)::bigint                               AS events,
            SUM(COALESCE((metadata->>'suppressed_in_previous_minute')::bigint, 0))::bigint AS suppressed
           FROM system_events
          WHERE event_type = 'rate_limit_429'
            AND created_at > NOW() - INTERVAL '24 hours'
          GROUP BY ip
          ORDER BY events DESC
          LIMIT 5`,
      ),
      pool.query<{ path: string; events: string; suppressed: string }>(
        `SELECT
            COALESCE(NULLIF(metadata->>'path', ''), 'unknown') AS path,
            COUNT(*)::bigint                                   AS events,
            SUM(COALESCE((metadata->>'suppressed_in_previous_minute')::bigint, 0))::bigint AS suppressed
           FROM system_events
          WHERE event_type = 'rate_limit_429'
            AND created_at > NOW() - INTERVAL '24 hours'
          GROUP BY path
          ORDER BY events DESC
          LIMIT 5`,
      ),
    ])
      .then(async ([totRes, hourRes, ipRes, pathRes]) => {
        const topIps: RateLimitSpike24hIp[] = ipRes.rows.map((row) => ({
          ip: row.ip,
          events: parseInt(row.events, 10),
          suppressed: parseInt(row.suppressed, 10),
        }));
        const topPaths: RateLimitSpike24hPath[] = pathRes.rows.map((row) => ({
          path: row.path,
          events: parseInt(row.events, 10),
          suppressed: parseInt(row.suppressed, 10),
        }));
        const hourlyBuckets: RateLimitSpike24hHourBucket[] = hourRes.rows.map(
          (row) => ({
            hour:
              row.hour instanceof Date
                ? row.hour.toISOString()
                : new Date(String(row.hour)).toISOString(),
            count: parseInt(row.count, 10),
          }),
        );
        const total429 = parseInt(totRes.rows[0]?.total ?? "0", 10);
        // Annotate with the alert evaluation so the dashboard banner and
        // the cron's system_event alert use the same source of truth.
        const { evaluateRateLimit24hSpikeAlert } =
          await import("./rateLimit429SpikeAlert");
        const evalResult = evaluateRateLimit24hSpikeAlert(total429);
        return {
          total429,
          totalSuppressed: parseInt(totRes.rows[0]?.suppressed ?? "0", 10),
          topIps,
          topPaths,
          hourlyBuckets,
          alertThreshold: evalResult.threshold,
          alertActive: evalResult.active,
        };
      })
      .catch((err: Error) => {
        rlLogger.warn(
          { err: err.message, component: "rateLimiter" },
          "24h spike query failed in getRateLimitStats — skipping spike24h",
        );
        return {
          total429: 0,
          totalSuppressed: 0,
          topIps: [],
          topPaths: [],
          hourlyBuckets: [],
          alertThreshold: 0,
          alertActive: false,
        };
      });

    // Rolling 1-minute window aggregated by key.
    // Buckets are written at second granularity by checkRateLimit()
    // (`INSERT ... date_trunc('second', NOW())`), so we mirror its
    // enforcement cutoff `NOW() - INTERVAL '1 minute' - INTERVAL '1 second'`
    // exactly. The extra second matches the limiter's conservative bound
    // and avoids a 1-second blind spot at the trailing edge.
    const [topRes, totalRes, recent429Count, spike24h] = await Promise.all([
      pool.query<{ key: string; total: string; latest_window_start: Date }>(
        `SELECT key,
                SUM(count)::bigint AS total,
                MAX(window_start)  AS latest_window_start
           FROM rate_limit_buckets
          WHERE window_start > NOW() - INTERVAL '1 minute' - INTERVAL '1 second'
          GROUP BY key
          ORDER BY total DESC
          LIMIT 10`,
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::bigint AS count FROM rate_limit_buckets`,
      ),
      recent429Promise,
      spike24hPromise,
    ]);

    baseStats.topKeys = topRes.rows.map((r) => ({
      key: r.key,
      count: parseInt(r.total, 10),
      window_start:
        r.latest_window_start instanceof Date
          ? r.latest_window_start.toISOString()
          : String(r.latest_window_start),
    }));
    baseStats.totalRows = parseInt(totalRes.rows[0]?.count ?? "0", 10);
    baseStats.recent429Count = recent429Count;
    baseStats.spike24h = spike24h;
    return baseStats;
  } catch (err) {
    baseStats.dbReachable = false;
    baseStats.dbError = (err as Error).message;
    return baseStats;
  }
}
