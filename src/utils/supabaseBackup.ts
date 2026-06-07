/**
 * Weekly Supabase refresh.
 *
 * Streams the live Replit Postgres into the Supabase fallback DB so a
 * recent snapshot is always available if Replit ever fails. Runs once a
 * week (Friday 23:00 Riyadh = 20:00 UTC) — see runWeeklySupabaseRefreshIfStale
 * in scheduledJobs.ts.
 *
 * Why batched INSERTs and not pg_dump:
 *   The Mastra runtime on Replit doesn't have pg_dump on PATH, and adding
 *   pg-copy-streams just for this would balloon the bundle. Batched INSERTs
 *   keep memory bounded (500 rows × N columns at a time) and rely only on
 *   `pg`, which is already a dependency.
 *
 * Safety rails:
 *   - Opt-in only: no-ops if SUPABASE_DATABASE_URL is unset.
 *   - Pool size = 2 on the Supabase client so we never blow the Transaction
 *     pooler's 100-client cap, even if multiple ticks overlap.
 *   - TRUNCATE … CASCADE on every table before re-inserting — guarantees
 *     a clean rewrite (no stale rows surviving in tables the source dropped).
 *   - System tables (pg_*, information_schema.*) are skipped automatically
 *     since we filter by schemaname='public'.
 */

import { Pool } from "pg";
import { sharedPool } from "./sharedPool";
import { logger } from "./logger";

const BATCH_SIZE = 500;

export interface BackupResult {
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  tablesProcessed: number;
  totalRowsCopied: number;
  perTable: Array<{ table: string; rows: number; ms: number }>;
  errors: Array<{ table: string; error: string }>;
}

/**
 * Execute the actual Replit → Supabase refresh. Caller is responsible for
 * scheduling / staleness checks; this just does the work.
 */
export async function runSupabaseRefresh(): Promise<BackupResult> {
  const supabaseUrl = process.env.SUPABASE_DATABASE_URL;
  if (!supabaseUrl) {
    throw new Error(
      "SUPABASE_DATABASE_URL is not set — cannot refresh Supabase",
    );
  }

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // Dedicated tiny pool. Two clients is enough — one INSERT batch at a
  // time, plus headroom for the TRUNCATE statement. Bigger pools risk
  // overwhelming the Supabase Transaction pooler when other Mastra
  // routes are also issuing queries.
  const targetPool = new Pool({
    connectionString: supabaseUrl,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 30_000,
  });

  const result: BackupResult = {
    startedAt,
    finishedAt: "",
    durationSeconds: 0,
    tablesProcessed: 0,
    totalRowsCopied: 0,
    perTable: [],
    errors: [],
  };

  try {
    // Discover all user tables on the source. `tablename` ordering is
    // arbitrary in pg_tables — we don't sort because FK ordering is
    // handled by deferring constraints (see disableTriggers below).
    const tablesRes = await sharedPool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
    );
    const tables = tablesRes.rows.map((r) => r.tablename);
    logger.info(
      `[SupabaseBackup] Starting refresh of ${tables.length} tables → Supabase`,
    );

    // Defer ALL constraints so we can TRUNCATE / INSERT in arbitrary order
    // without tripping FKs. Wrapped in a single transaction on the target.
    const targetClient = await targetPool.connect();
    try {
      await targetClient.query("BEGIN");
      await targetClient.query("SET CONSTRAINTS ALL DEFERRED");

      for (const table of tables) {
        const tableT0 = Date.now();
        const quoted = `"${table.replace(/"/g, '""')}"`;
        let rowsCopied = 0;
        try {
          // 1. Wipe the target table.
          await targetClient.query(`TRUNCATE TABLE ${quoted} CASCADE`);

          // 2. Stream rows from source in fixed batches.
          let offset = 0;
          while (true) {
            const batch = await sharedPool.query(
              `SELECT * FROM ${quoted} ORDER BY ctid LIMIT $1 OFFSET $2`,
              [BATCH_SIZE, offset],
            );
            if (batch.rows.length === 0) break;

            const columns = Object.keys(batch.rows[0]);
            const quotedCols = columns
              .map((c) => `"${c.replace(/"/g, '""')}"`)
              .join(",");
            const valuesSql = batch.rows
              .map((_row, rowIdx) => {
                const placeholders = columns
                  .map(
                    (_col, colIdx) =>
                      `$${rowIdx * columns.length + colIdx + 1}`,
                  )
                  .join(",");
                return `(${placeholders})`;
              })
              .join(",");
            const params = batch.rows.flatMap((row) =>
              columns.map((c) => row[c]),
            );

            await targetClient.query(
              `INSERT INTO ${quoted} (${quotedCols}) VALUES ${valuesSql}`,
              params,
            );
            rowsCopied += batch.rows.length;
            offset += batch.rows.length;
            if (batch.rows.length < BATCH_SIZE) break;
          }

          result.perTable.push({
            table,
            rows: rowsCopied,
            ms: Date.now() - tableT0,
          });
          result.totalRowsCopied += rowsCopied;
          result.tablesProcessed += 1;
        } catch (err: any) {
          // Don't kill the whole backup on one table — log and continue.
          // The scheduledJobs caller will report the per-table errors.
          result.errors.push({
            table,
            error: err?.message || String(err),
          });
          logger.error(
            `[SupabaseBackup] Failed on table ${table}: ${err?.message || err}`,
          );
        }
      }

      await targetClient.query("COMMIT");
    } catch (err) {
      // Transactional rollback so a mid-flight failure doesn't leave the
      // target half-truncated.
      try {
        await targetClient.query("ROLLBACK");
      } catch {
        /* swallow — we're already in an error path */
      }
      throw err;
    } finally {
      targetClient.release();
    }
  } finally {
    await targetPool.end();
  }

  result.finishedAt = new Date().toISOString();
  result.durationSeconds = (Date.now() - t0) / 1000;
  logger.info(
    `[SupabaseBackup] Done in ${result.durationSeconds.toFixed(1)}s — ${result.tablesProcessed}/${result.tablesProcessed + result.errors.length} tables, ${result.totalRowsCopied} rows, ${result.errors.length} errors`,
  );
  return result;
}
