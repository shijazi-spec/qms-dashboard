import pg from 'pg';
import pino from 'pino';

const { Pool } = pg;

const rlLogger = pino({ level: 'warn', name: 'rateLimiter' });

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
const WRITE_LIMIT = 10;
const AUTH_LIMIT = 5;
const EXPORT_LIMIT = 10;
const UNAUTH_READ_LIMIT = 10;
const UNAUTH_WRITE_LIMIT = 3;

const AUTH_PATHS = ['/api/auth/', '/api/invitations/accept', '/login', '/api/admin/auth'];
const EXPORT_PATHS = ['/export', '/pdf'];

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

ensureTable().catch(err => {
  rlLogger.warn({ err, component: 'rateLimiter' }, 'rate_limit_buckets table setup failed at startup — rate limiter will fail-open until DB is reachable');
});

function getCategory(path?: string): string {
  if (path) {
    if (AUTH_PATHS.some(p => path.startsWith(p) || path.includes(p))) return 'auth';
    if (EXPORT_PATHS.some(p => path.includes(p))) return 'export';
  }
  return 'general';
}

const TRUST_PROXY_HOPS = (() => {
  const raw = process.env.TRUST_PROXY_HOPS;
  const parsed = parseInt(raw ?? '0', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
})();

function isValidOctet(s: string): boolean {
  if (!/^\d{1,3}$/.test(s)) return false;
  const n = parseInt(s, 10);
  return n >= 0 && n <= 255;
}

function sanitizeIp(raw: string): string {
  const t = raw.trim();
  // IPv4-mapped IPv6 (e.g. ::ffff:1.2.3.4) — normalize to IPv4 tail
  const v4mapped = t.match(/^[a-fA-F0-9:]+:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (v4mapped && v4mapped[1].split('.').every(isValidOctet)) return v4mapped[1];
  // Pure IPv4 — validate all four octets
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(t) && t.split('.').every(isValidOctet)) return t;
  // IPv6 — must contain ≥ 2 colons (rules out plain hex strings like "deadbeef")
  if (/^[a-fA-F0-9:]+$/.test(t) && (t.match(/:/g) ?? []).length >= 2) return t;
  return 'invalid';
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
 * IPv4-mapped IPv6 (e.g. ::ffff:1.2.3.4) is normalized to IPv4.
 * TRUST_PROXY_HOPS env var (default 0) must not exceed the count of proxies you control.
 */
export function parseClientIp(
  xForwardedFor: string | undefined,
  xRealIp: string | undefined,
): string {
  if (TRUST_PROXY_HOPS > 0 && xRealIp) {
    const s = sanitizeIp(xRealIp);
    if (s !== 'invalid') return s;
  }
  if (xForwardedFor) {
    const ips = xForwardedFor.split(',').map(s => s.trim()).filter(Boolean);
    if (ips.length > 0) {
      const idx = Math.max(0, ips.length - TRUST_PROXY_HOPS - 1);
      const s = sanitizeIp(ips[idx]);
      if (s !== 'invalid') return s;
    }
  }
  return 'unknown';
}

export async function checkRateLimit(
  ip: string,
  isWrite: boolean,
  path?: string,
  isAuthenticated: boolean = true,
  userId?: string,
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const category = getCategory(path);

  const identifier = userId && isAuthenticated ? `user:${userId}` : `ip:${ip}`;
  const authPrefix = isAuthenticated ? 'auth' : 'unauth';
  const key =
    category === 'auth'
      ? `${identifier}:authflow`
      : `${identifier}:${authPrefix}:${category}:${isWrite ? 'w' : 'r'}`;

  let limit: number;
  if (category === 'auth') {
    limit = AUTH_LIMIT;
  } else if (category === 'export') {
    limit = EXPORT_LIMIT;
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
      const oldestMs = row.oldest_epoch ? parseFloat(row.oldest_epoch) * 1000 : nowMs;
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
      { err: (err as Error).message, key, failOpenCount, component: 'rateLimiter' },
      'Rate limiter DB unreachable — failing open (counter incremented)',
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

export interface RateLimitStats {
  windowMs: number;
  windowStart: string;
  topKeys: RateLimitTopKey[];
  totalRows: number;
  failOpenCount: number;
  recent429Count: number;
  dbReachable: boolean;
  dbError?: string;
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
      .then(r => parseInt(r.rows[0]?.count ?? '0', 10))
      .catch((err: Error) => {
        rlLogger.warn(
          { err: err.message, component: 'rateLimiter' },
          'system_events query failed in getRateLimitStats — defaulting recent429Count to 0',
        );
        return 0;
      });

    // Rolling 1-minute window aggregated by key.
    // Buckets are written at second granularity by checkRateLimit()
    // (`INSERT ... date_trunc('second', NOW())`), so we mirror its
    // enforcement cutoff `NOW() - INTERVAL '1 minute' - INTERVAL '1 second'`
    // exactly. The extra second matches the limiter's conservative bound
    // and avoids a 1-second blind spot at the trailing edge.
    const [topRes, totalRes, recent429Count] = await Promise.all([
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
    ]);

    baseStats.topKeys = topRes.rows.map(r => ({
      key: r.key,
      count: parseInt(r.total, 10),
      window_start:
        r.latest_window_start instanceof Date
          ? r.latest_window_start.toISOString()
          : String(r.latest_window_start),
    }));
    baseStats.totalRows = parseInt(totalRes.rows[0]?.count ?? '0', 10);
    baseStats.recent429Count = recent429Count;
    return baseStats;
  } catch (err) {
    baseStats.dbReachable = false;
    baseStats.dbError = (err as Error).message;
    return baseStats;
  }
}
