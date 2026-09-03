/**
 * Side-effect module: normalizes the SSL mode of DATABASE_URL at process
 * startup, before any connection pool or Mastra PostgresStore is constructed.
 *
 * Why this exists:
 *   Newer versions of `pg-connection-string` (bundled via `pg`) changed the
 *   meaning of `sslmode=require` (and `prefer` / `verify-ca`) so they are now
 *   treated as `verify-full` — i.e. strict TLS certificate-chain verification.
 *   In the deployment environment the managed Postgres certificate cannot be
 *   verified against the system CA bundle, so the TLS handshake is aborted with
 *   "Client network socket disconnected before secure TLS connection was
 *   established", which crash-loops the server (every page → Internal Server
 *   Error).
 *
 *   The connection is still encrypted; we only restore the prior behavior of
 *   NOT requiring full certificate-chain verification, which is the libpq
 *   semantics of `sslmode=require`. We express it as `sslmode=no-verify`, which
 *   `pg-connection-string` maps to `ssl: { rejectUnauthorized: false }`.
 *
 *   This is a no-op in development, whose DATABASE_URL carries no `sslmode`.
 *
 * Import this FIRST in the application entry point so the rewrite happens before
 * `process.env.DATABASE_URL` is read by any pool or PostgresStore.
 */
import { logger } from "./logger";

const STRICT_MODES = new Set(["require", "prefer", "verify-ca"]);

/**
 * Pure, idempotent transform: given a Postgres connection string, rewrite any
 * strict `sslmode` (`require` / `prefer` / `verify-ca`) to `no-verify` and
 * return the result. Returns the input unchanged when there is nothing to do
 * (no `sslmode`, already `no-verify`, or an explicit `verify-full` / `disable`).
 *
 * Apply this DIRECTLY to a connection string at each construction site that
 * cannot guarantee the `process.env.DATABASE_URL` side-effect below has already
 * run — most importantly `PostgresStore`, whose failure crash-loops the whole
 * server. Relying on env-mutation ordering alone is fragile: in the production
 * bundle a module-scope consumer can read `process.env.DATABASE_URL` before this
 * module's side-effect executes, reintroducing the verify-full TLS crash.
 */
export function normalizeSslMode(raw: string | undefined): string | undefined {
  if (!raw) return raw;

  try {
    const url = new URL(raw);
    const mode = url.searchParams.get("sslmode");
    const lowered = mode?.toLowerCase();
    if (lowered && STRICT_MODES.has(lowered)) {
      url.searchParams.set("sslmode", "no-verify");
      return url.toString();
    }
    return raw;
  } catch {
    // Connection string is not URL-parseable (e.g. a libpq key=value DSN such
    // as "host=... port=5432 sslmode=require dbname=..."). Handle BOTH the
    // URL-style query token (?sslmode= / &sslmode=) and the space-delimited
    // libpq DSN token (^sslmode= / " sslmode="), case-insensitively, so a
    // future switch to DSN format cannot reintroduce the verify-full crash.
    // The leading delimiter is captured and preserved; the trailing lookahead
    // anchors on a value boundary so `verify-full` / `required` are never
    // partially matched.
    return raw.replace(
      /(^|[?&\s])(sslmode=)(require|prefer|verify-ca)(?=$|[\s&])/i,
      "$1$2no-verify",
    );
  }
}

function normalizeDatabaseUrlSsl(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) return;

  const normalized = normalizeSslMode(raw);
  if (normalized && normalized !== raw) {
    process.env.DATABASE_URL = normalized;
    // Mode keyword only — never the connection string (which holds credentials).
    logger.info(
      "[DB-SSL] Normalized DATABASE_URL sslmode -> 'no-verify' for TLS compatibility",
    );
  }
}

normalizeDatabaseUrlSsl();
