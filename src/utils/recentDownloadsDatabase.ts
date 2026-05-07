// ──────────────────────────────────────────────────────────────────────────────
// Recent-downloads persistence layer (Task #746)
//
// Moved out of `src/mastra/routes/exportDownloadRoutes.ts` so the only
// INSERT/UPDATE against `user_recent_downloads` lives in a *Database.ts
// module and the secret-leak coverage gate (scripts/check-db-test-coverage.sh)
// no longer tracks the route file separately.
//
// The companion secret-leak test for the write path is the existing
// `src/mastra/routes/exportDownloadRoutes.test.ts` (mapped via
// COMPANION_TESTS in scripts/check-db-test-coverage.sh). It patches
// `pg.Pool.prototype.query` globally, so calls issued by this module's pool
// are still captured.
// ──────────────────────────────────────────────────────────────────────────────

import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let tableReady = false;

export async function ensureRecentDownloadsTable(): Promise<void> {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_recent_downloads (
      user_id INTEGER PRIMARY KEY,
      entries  JSONB    NOT NULL DEFAULT '[]',
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  tableReady = true;
}

export async function getRecentDownloads(userId: number): Promise<unknown[]> {
  const result = await pool.query(
    "SELECT entries FROM user_recent_downloads WHERE user_id = $1",
    [userId],
  );
  return result.rows.length > 0 ? result.rows[0].entries : [];
}

/**
 * Persist the given entries blob. Callers MUST scrub deny-list keys / credential-
 * shaped strings via `redactSensitiveDeep()` before calling — the route layer
 * owns the redaction policy so this module stays generic.
 */
export async function upsertRecentDownloads(
  userId: number,
  safeEntries: unknown[],
): Promise<void> {
  await pool.query(
    `INSERT INTO user_recent_downloads (user_id, entries, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE
     SET entries = $2::jsonb, updated_at = NOW()`,
    [userId, JSON.stringify(safeEntries)],
  );
}

export async function clearRecentDownloads(userId: number): Promise<void> {
  await pool.query(
    "DELETE FROM user_recent_downloads WHERE user_id = $1",
    [userId],
  );
}
