/**
 * Redacted-pool wrapper — auto-scrubs INSERT/UPDATE params for secret leaks.
 *
 * Why this exists
 * ---------------
 * Task #268 introduced a CI gate (`scripts/check-db-test-coverage.sh`) that
 * requires every `src/utils/*Database.ts` writer to ship with a companion
 * secret-leak test that mocks `pg.Pool.prototype.query` and asserts the five
 * deny-list keys (password_hash, mfa_secret, access_token, refresh_token,
 * api_key) never reach the captured INSERT/UPDATE params vector.
 *
 * For two writers (changeHistoryDatabase, eventLogsDatabase) this protection
 * was wired by hand inside the writer body via `redactSensitiveDeep(...)`.
 * The remaining 25+ writers were temporarily allow-listed via the
 * `GRANDFATHERED` map. Task #459 backfills the missing tests — the cleanest
 * way to make the assertions hold for so many modules at once is to
 * intercept the `pool.query()` call site uniformly so any writer that goes
 * through the wrapped pool inherits the redaction guarantee.
 *
 * The wrapper is intentionally narrow:
 *
 *   1. It only mutates params for SQL statements that begin with INSERT,
 *      UPDATE, UPSERT, MERGE, or `WITH ... INSERT/UPDATE` (CTE-prefixed
 *      writes). SELECT and DELETE WHERE-clause params pass through
 *      unchanged so an exact-match `WHERE password_hash = $1` lookup
 *      against the existing audit row continues to behave identically.
 *
 *   2. Each positional param is delegated to `redactSensitiveDeep`, which
 *      handles every input shape uniformly:
 *        - strings: scrubbed via `redactSecretLikeStrings`; `{`/`[`-prefixed
 *          values that parse as JSON are walked recursively and
 *          re-stringified (Task #741 moved this JSON-of-JSON branch into
 *          `redactSensitiveDeep` itself, so this wrapper no longer needs a
 *          parallel hand-rolled copy).
 *        - object/array: walked via the key-based deny list with a
 *          recursive regex scrub of every string leaf.
 *        - other primitives (number, boolean, Buffer, Date, typed arrays)
 *          pass through unchanged.
 *
 *   3. The instance is tagged with `Symbol.for('@ExampleOrg/redacted-pool')`
 *      so wrapping is idempotent — re-wrapping a shared pool from multiple
 *      consumers does not double-scrub.
 */

import "./normalizeDatabaseUrl";
import pg from 'pg';
import { redactSensitiveDeep } from './eventLogsDatabase';
import { attachPoolErrorHandler } from './processSafetyNet';

const { Pool } = pg;

const WRITE_HEAD_RE = /^\s*(?:INSERT|UPDATE|UPSERT|MERGE|WITH\b)/i;
const REDACTED_FLAG = Symbol.for('@ExampleOrg/redacted-pool');

function isWriteSql(sql: unknown): boolean {
  const text =
    typeof sql === 'string'
      ? sql
      : sql && typeof sql === 'object' && typeof (sql as { text?: unknown }).text === 'string'
        ? (sql as { text: string }).text
        : '';
  return WRITE_HEAD_RE.test(text);
}

/**
 * Apply the deep secret-leak scrub to a single positional pg query parameter.
 * Exported for direct unit testing — production code should reach this via
 * `wrapPoolForRedaction` rather than calling it explicitly.
 */
export function redactPgParam(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object') {
    // Per the param-handling contract documented above, non-plain objects
    // (Date, Buffer, typed arrays) pass through to pg's native serializer
    // unchanged — `redactSensitiveDeep` would strip their internal slots and
    // hand pg an empty `{}` (e.g. `invalid input syntax for type timestamp:
    // "{}"`).
    if (value instanceof Date) return value;
    if (Buffer.isBuffer(value)) return value;
    if (ArrayBuffer.isView(value)) return value;
    return redactSensitiveDeep(value);
  }
  if (typeof value === 'string') {
    // `redactSensitiveDeep` already detects `{`/`[`-prefixed JSON-string
    // values, walks them recursively, and re-stringifies the result
    // (Task #741) — so a single delegating call covers both the JSON-of-JSON
    // case and the plain-string regex/heuristic scrub.
    const scrubbed = redactSensitiveDeep(value);
    return typeof scrubbed === 'string' ? scrubbed : value;
  }
  return value;
}

function redactParamsArray(values: unknown[]): unknown[] {
  return values.map(redactPgParam);
}

/**
 * Wraps a `query`-bearing target (a Pool or a checked-out PoolClient) so any
 * INSERT/UPDATE/UPSERT/MERGE/CTE-write has its positional params recursively
 * scrubbed before they reach Postgres. Used by `wrapPoolForRedaction` for
 * both the pool itself and clients handed out by `pool.connect()`.
 */
function wrapQueryMethod<T extends { query: (...args: unknown[]) => unknown }>(target: T): void {
  const originalQuery = target.query.bind(target) as (
    sqlOrConfig: unknown,
    params?: unknown,
    callback?: unknown,
  ) => unknown;

  (target as unknown as { query: (...args: unknown[]) => unknown }).query = function (
    this: T,
    sqlOrConfig: unknown,
    params?: unknown,
    callback?: unknown,
  ): unknown {
    if (
      sqlOrConfig &&
      typeof sqlOrConfig === 'object' &&
      Array.isArray((sqlOrConfig as { values?: unknown }).values) &&
      isWriteSql(sqlOrConfig)
    ) {
      const cfg = sqlOrConfig as { values: unknown[] } & Record<string, unknown>;
      const safeConfig = { ...cfg, values: redactParamsArray(cfg.values) };
      return originalQuery(safeConfig, params, callback);
    }
    if (Array.isArray(params) && isWriteSql(sqlOrConfig)) {
      return originalQuery(sqlOrConfig, redactParamsArray(params), callback);
    }
    return originalQuery(sqlOrConfig, params, callback);
  };
}

/**
 * Wraps a pg.Pool in place so every INSERT/UPDATE/UPSERT/MERGE/CTE-write
 * has its positional params recursively scrubbed for credential-shaped
 * substrings and deny-list-named keys before they reach Postgres.
 *
 * The wrapper extends to checked-out PoolClients via `pool.connect()` so
 * transactional writers (e.g. `await client.query('BEGIN'); ...`) inherit the
 * same redaction guarantee as direct `pool.query()` callers.
 *
 * Idempotent — calling twice returns the same pool reference and the
 * interceptor is installed at most once.
 */
export function wrapPoolForRedaction<P extends pg.Pool>(pool: P): P {
  const tagged = pool as unknown as Record<symbol, unknown>;
  if (tagged[REDACTED_FLAG]) return pool;

  // node-postgres emits 'error' on the POOL when a backend error or network
  // drop hits an IDLE client, and an unhandled 'error' event is fatal in Node.
  // These are routine (a Postgres restart, a provider-side idle timeout) and
  // must never take the instance down. Attached here so every pool built
  // through this factory is covered by construction.
  attachPoolErrorHandler(pool as unknown as { on: (e: string, cb: (err: Error) => void) => unknown });

  // `pool.query` — the direct path.
  wrapQueryMethod(pool as unknown as { query: (...args: unknown[]) => unknown });

  // `pool.connect()` — wrap the returned PoolClient so `client.query(...)`
  // inside a transaction is redacted just like the direct pool path.
  const originalConnect = pool.connect.bind(pool) as (
    ...args: unknown[]
  ) => unknown;

  (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = function (
    this: P,
    ...args: unknown[]
  ): unknown {
    const result = originalConnect(...args);
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return (result as Promise<pg.PoolClient>).then((client) => {
        const taggedClient = client as unknown as Record<symbol, unknown>;
        if (!taggedClient[REDACTED_FLAG]) {
          wrapQueryMethod(client as unknown as { query: (...args: unknown[]) => unknown });
          taggedClient[REDACTED_FLAG] = true;
        }
        return client;
      });
    }
    return result;
  };

  tagged[REDACTED_FLAG] = true;
  return pool;
}

/**
 * Convenience wrapper used by writers that own their own pg.Pool. Returns a
 * freshly-instantiated pool already wrapped with the redaction interceptor.
 */
/**
 * Connection-budget defaults (2026-08-30). ~36 modules call this, each getting
 * its OWN pg.Pool. At node-pg's default `max: 10` that is 360 possible
 * connections from a single instance — far over the provider's cap. Exhausting
 * it makes new connects fail with "Connection terminated unexpectedly", which
 * is what took AssistantPersona down (Mastra's PostgresStore.init could not get a
 * connection while a fan-out request had the pools saturated).
 *
 * - `max: 3`      — most of these modules are low-traffic; hot modules override
 *                   explicitly (duplicateRadarDatabase passes `max: 10`).
 * - `keepAlive`   — stops idle sockets being silently dropped by the provider,
 *                   the other source of "Connection terminated unexpectedly".
 * - `connectionTimeoutMillis` — fail fast with a clear error instead of hanging
 *                   forever when the pool genuinely is saturated.
 *
 * `idleTimeoutMillis` is deliberately left at node-pg's 10s default so idle
 * connections are returned to the provider quickly. Caller config wins — the
 * spread comes last.
 */
export function createRedactedPool(config?: pg.PoolConfig): pg.Pool {
  return wrapPoolForRedaction(
    new Pool({
      max: 3,
      keepAlive: true,
      connectionTimeoutMillis: 15_000,
      ...config,
    }),
  );
}
