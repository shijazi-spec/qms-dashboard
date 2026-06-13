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
 *   semantics of `sslmode=require` and exactly what the driver warning
 *   recommends (`uselibpqcompat=true&sslmode=require`). We express it as
 *   `sslmode=no-verify`, which `pg-connection-string` maps to
 *   `ssl: { rejectUnauthorized: false }`.
 *
 *   This is a no-op in development, whose DATABASE_URL carries no `sslmode`.
 *
 * Import this FIRST in the application entry point so the rewrite happens before
 * `process.env.DATABASE_URL` is read by any pool or PostgresStore.
 */
const STRICT_MODES = new Set(["require", "prefer", "verify-ca"]);

function normalizeDatabaseUrlSsl(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) return;

  try {
    const url = new URL(raw);
    const mode = url.searchParams.get("sslmode");
    if (mode && STRICT_MODES.has(mode)) {
      url.searchParams.set("sslmode", "no-verify");
      process.env.DATABASE_URL = url.toString();
    }
    return;
  } catch {
    // Non-URL-parseable connection string (e.g. key=value form) — fall back to
    // a targeted string replacement.
    const replaced = raw.replace(
      /([?&]sslmode=)(require|prefer|verify-ca)\b/i,
      "$1no-verify",
    );
    if (replaced !== raw) {
      process.env.DATABASE_URL = replaced;
    }
  }
}

normalizeDatabaseUrlSsl();
