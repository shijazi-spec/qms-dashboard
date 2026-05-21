/**
 * Prod → Dev DB Sync Cron
 *
 * Goal: keep the dev workspace's Postgres mirroring production for a fixed
 * set of business tables, so the preview pane always reflects real data.
 *
 * How it works:
 *   1. Connects to production via the `PROD_DATABASE_URL` secret (read-only).
 *   2. For each table in TABLES below: snapshots prod's id range, then
 *      TRUNCATEs dev and re-inserts in keyset-paginated chunks using
 *      `session_replication_role = replica` so foreign-key triggers and
 *      audit triggers don't fire during the bulk reload.
 *   3. Logs a per-table summary row to `system_events`.
 *
 * Safety guards (fail-closed):
 *   • Skips entirely if NODE_ENV === "production" — this job must NEVER run
 *     in prod (it would TRUNCATE prod tables).
 *   • Skips entirely if PROD_DATABASE_URL is not set.
 *   • Skips entirely if PROD_DATABASE_URL === DATABASE_URL (i.e. someone
 *     mis-configured dev to point at prod).
 *
 * Schedule: daily at 04:00 by default; override with PROD_TO_DEV_SYNC_CRON.
 */

import pg from "pg";
import { inngest } from "../inngest/client";
import { logger } from "../../utils/logger";

const { Pool } = pg;

type TableSpec = {
  name: string;
  cursorCol: string;
  cursorIsNumeric: boolean;
  chunk: number;
  /** Columns to NULL out before transferring (e.g. blobs too large to ship). */
  nullColumns?: string[];
  /** When true, paginate by integer OFFSET instead of keyset (use only for
   *  composite-PK tables where keyset is awkward). */
  useOffset?: boolean;
};

/** The 18 tables that today's manual sync covers. Ordered roughly by
 *  dependency (parents before children where it matters). */
export const TABLES: TableSpec[] = [
  { name: "platform_users", cursorCol: "id", cursorIsNumeric: true, chunk: 500 },
  { name: "quality_audit_results", cursorCol: "id", cursorIsNumeric: true, chunk: 5, nullColumns: ["raw_audit_data"] },
  { name: "quality_trends", cursorCol: "id", cursorIsNumeric: true, chunk: 500 },
  { name: "audit_notifications", cursorCol: "id", cursorIsNumeric: true, chunk: 500 },
  { name: "audit_triggers", cursorCol: "id", cursorIsNumeric: true, chunk: 500 },
  { name: "digest_delivery_runs", cursorCol: "id", cursorIsNumeric: true, chunk: 500 },
  { name: "duplicate_detection_logs", cursorCol: "id", cursorIsNumeric: true, chunk: 500 },
  { name: "notification_outbox", cursorCol: "id", cursorIsNumeric: true, chunk: 500 },
  { name: "notifications", cursorCol: "id", cursorIsNumeric: true, chunk: 500 },
  { name: "system_events", cursorCol: "id", cursorIsNumeric: true, chunk: 500 },
  { name: "scanner_run_log", cursorCol: "id", cursorIsNumeric: true, chunk: 50 },
  { name: "tool_health_config_audit", cursorCol: "id", cursorIsNumeric: true, chunk: 500 },
  { name: "ai_call_metrics", cursorCol: "id", cursorIsNumeric: true, chunk: 500 },
  { name: "event_logs_y2026m04", cursorCol: "id", cursorIsNumeric: true, chunk: 200 },
  { name: "event_logs_y2026m05", cursorCol: "id", cursorIsNumeric: true, chunk: 200 },
  { name: "event_logs_y2026m06", cursorCol: "id", cursorIsNumeric: true, chunk: 200 },
  { name: "ai_alerts", cursorCol: "id", cursorIsNumeric: true, chunk: 200 },
  { name: "duplicate_clusters", cursorCol: "id", cursorIsNumeric: true, chunk: 500 },
  { name: "rate_limit_buckets", cursorCol: "", cursorIsNumeric: false, chunk: 1000, useOffset: true },
];

export type TableSyncResult = {
  table: string;
  prodRows: number;
  devRows: number;
  ok: boolean;
  error?: string;
  durationMs: number;
};

export type SyncRunResult = {
  ranAt: string;
  skipped?: string;
  durationMs: number;
  tables: TableSyncResult[];
};

function safetyCheck(): string | null {
  if (process.env.NODE_ENV === "production") {
    return "refusing to run in production (this job truncates target tables)";
  }
  const prodUrl = process.env.PROD_DATABASE_URL;
  if (!prodUrl) return "PROD_DATABASE_URL is not set";
  if (prodUrl === process.env.DATABASE_URL) {
    return "PROD_DATABASE_URL === DATABASE_URL — refusing to truncate-and-reload the same database";
  }
  return null;
}

async function syncTable(
  prodPool: pg.Pool,
  devPool: pg.Pool,
  spec: TableSpec,
): Promise<TableSyncResult> {
  const t0 = Date.now();
  const out: TableSyncResult = {
    table: spec.name,
    prodRows: 0,
    devRows: 0,
    ok: false,
    durationMs: 0,
  };

  try {
    const { rows: countRows } = await prodPool.query(
      `SELECT COUNT(*)::int AS n FROM "${spec.name}"`,
    );
    out.prodRows = countRows[0]?.n ?? 0;

    // Build SELECT column list, NULLing out any blob columns we don't ship.
    const { rows: colRows } = await prodPool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1
       ORDER BY ordinal_position`,
      [spec.name],
    );
    if (colRows.length === 0) {
      out.error = "table not found in prod";
      out.durationMs = Date.now() - t0;
      return out;
    }
    const selectCols = colRows
      .map((c: any) => {
        if (spec.nullColumns?.includes(c.column_name)) {
          return `NULL::${c.data_type === "jsonb" ? "jsonb" : c.data_type === "json" ? "json" : "text"} AS "${c.column_name}"`;
        }
        return `"${c.column_name}"`;
      })
      .join(", ");

    // Truncate dev with triggers disabled so FKs/audit-triggers don't fire.
    const dev = await devPool.connect();
    try {
      await dev.query("BEGIN");
      await dev.query("SET LOCAL session_replication_role = replica");
      await dev.query(`TRUNCATE TABLE "${spec.name}" CASCADE`);
      await dev.query("COMMIT");
    } finally {
      dev.release();
    }

    if (out.prodRows === 0) {
      out.ok = true;
      out.devRows = 0;
      out.durationMs = Date.now() - t0;
      return out;
    }

    // Stream prod → dev in chunks.
    if (spec.useOffset) {
      for (let off = 0; off < out.prodRows; off += spec.chunk) {
        const { rows } = await prodPool.query(
          `SELECT ${selectCols} FROM "${spec.name}" OFFSET $1 LIMIT $2`,
          [off, spec.chunk],
        );
        if (rows.length === 0) break;
        await insertChunk(devPool, spec.name, rows);
      }
    } else {
      let cursor: any = null;
      while (true) {
        const where =
          cursor === null
            ? ""
            : `WHERE "${spec.cursorCol}" > ${spec.cursorIsNumeric ? "$1" : "$1"}`;
        const params = cursor === null ? [] : [cursor];
        const { rows } = await prodPool.query(
          `SELECT ${selectCols} FROM "${spec.name}" ${where}
           ORDER BY "${spec.cursorCol}" LIMIT ${spec.chunk}`,
          params,
        );
        if (rows.length === 0) break;
        await insertChunk(devPool, spec.name, rows);
        cursor = rows[rows.length - 1][spec.cursorCol];
        if (rows.length < spec.chunk) break;
      }
    }

    // Bump serial sequence if the table has one on `id`.
    const { rows: seqRows } = await devPool.query(
      `SELECT pg_get_serial_sequence($1, 'id') AS seq`,
      [spec.name],
    );
    if (seqRows[0]?.seq) {
      await devPool.query(
        `SELECT setval($1::regclass,
           GREATEST((SELECT COALESCE(MAX(id), 1) FROM "${spec.name}"), 1))`,
        [seqRows[0].seq],
      );
    }

    const { rows: devCountRows } = await devPool.query(
      `SELECT COUNT(*)::int AS n FROM "${spec.name}"`,
    );
    out.devRows = devCountRows[0]?.n ?? 0;
    out.ok = out.devRows >= out.prodRows; // allow >= because live writes may add rows after sync
  } catch (err: any) {
    out.error = String(err?.message ?? err).slice(0, 500);
    logger.error("[prodToDevSync] table failed", {
      table: spec.name,
      error: out.error,
    });
  }

  out.durationMs = Date.now() - t0;
  return out;
}

async function insertChunk(
  devPool: pg.Pool,
  tableName: string,
  rows: any[],
): Promise<void> {
  if (rows.length === 0) return;
  const json = JSON.stringify(rows);
  const dev = await devPool.connect();
  try {
    await dev.query("BEGIN");
    await dev.query("SET LOCAL session_replication_role = replica");
    await dev.query(
      `INSERT INTO "${tableName}"
       SELECT * FROM jsonb_populate_recordset(NULL::"${tableName}", $1::jsonb)
       ON CONFLICT DO NOTHING`,
      [json],
    );
    await dev.query("COMMIT");
  } catch (e) {
    try {
      await dev.query("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    dev.release();
  }
}

export async function runProdToDevSync(): Promise<SyncRunResult> {
  const t0 = Date.now();
  const ranAt = new Date().toISOString();

  const skip = safetyCheck();
  if (skip) {
    logger.warn("[prodToDevSync] skipping run", { reason: skip });
    return { ranAt, skipped: skip, durationMs: Date.now() - t0, tables: [] };
  }

  const prodPool = new Pool({
    connectionString: process.env.PROD_DATABASE_URL,
    max: 4,
    statement_timeout: 60_000,
  });
  const devPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
    statement_timeout: 120_000,
  });

  const results: TableSyncResult[] = [];
  try {
    for (const spec of TABLES) {
      results.push(await syncTable(prodPool, devPool, spec));
    }
  } finally {
    await prodPool.end().catch(() => {});
    await devPool.end().catch(() => {});
  }

  const summary: SyncRunResult = {
    ranAt,
    durationMs: Date.now() - t0,
    tables: results,
  };

  // Best-effort: record a `system_events` row for visibility in the AI Ops UI.
  try {
    const dev = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    await dev.query(
      `INSERT INTO system_events (event_type, severity, payload, created_at)
       VALUES ('prod_to_dev_sync', $1, $2::jsonb, NOW())`,
      [
        results.every((r) => r.ok) ? "info" : "warning",
        JSON.stringify(summary),
      ],
    );
    await dev.end().catch(() => {});
  } catch (e: any) {
    logger.warn("[prodToDevSync] failed to record system_events row", {
      error: String(e?.message ?? e).slice(0, 200),
    });
  }

  logger.info("[prodToDevSync] run complete", {
    durationMs: summary.durationMs,
    tables: results.map((r) => ({
      t: r.table,
      prod: r.prodRows,
      dev: r.devRows,
      ok: r.ok,
    })),
  });

  return summary;
}

export const prodToDevSyncFunction = inngest.createFunction(
  { id: "prod-to-dev-db-sync" },
  { cron: process.env.PROD_TO_DEV_SYNC_CRON || "0 4 * * *" },
  async ({ step }) => {
    return await step.run("run-prod-to-dev-sync", async () => {
      return await runProdToDevSync();
    });
  },
);
