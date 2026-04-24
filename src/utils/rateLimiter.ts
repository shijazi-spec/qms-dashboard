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

  const now = Date.now();
  const windowStart = new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS);
  const windowEnd = new Date(windowStart.getTime() + WINDOW_MS);
  const retryAfter = Math.ceil((windowEnd.getTime() - now) / 1000);

  try {
    await ensureTable();
    const result = await getPool().query<{ count: string }>(
      `INSERT INTO rate_limit_buckets (key, window_start, count)
       VALUES ($1, $2, 1)
       ON CONFLICT (key, window_start)
       DO UPDATE SET count = rate_limit_buckets.count + 1
       RETURNING count`,
      [key, windowStart.toISOString()],
    );

    const count = parseInt(result.rows[0].count, 10);
    if (count > limit) {
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
