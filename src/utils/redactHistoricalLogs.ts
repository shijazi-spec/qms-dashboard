/**
 * One-off migration: scan existing event_logs and change_history rows for
 * sensitive field values and rewrite them to ***REDACTED***.
 *
 * Uses the SAME deny-list + regex-scrubber logic as redactSensitiveFields() and
 * redactSecretLikeStrings() — imported from eventLogsDatabase.ts — so there is
 * no duplication or drift risk between the write-time path and this sweep.
 *
 * Tables covered (Task #250 ensures all three change-history tables are
 * processed in the same scheduled run, so a database restore from a
 * pre-Task-#99 backup cannot reintroduce leaked credentials):
 *
 *   - event_logs              (description, entity_name, old_value, new_value)
 *   - nc_change_history       (old_value, new_value, change_reason)
 *   - capa_change_history     (old_value, new_value, change_reason)
 *   - ai_pending_actions      (payload, payload_preview, execution_result)
 *
 * Detection strategy: apply redactSensitiveFields() / redactSecretLikeStrings()
 * to each column and compare against the original. If they differ, the row
 * needs updating. This correctly handles partially-redacted rows that may
 * still contain additional unmasked sensitive material.
 *
 * Each updated event_logs JSON object gains a `_redacted_at` breadcrumb key
 * (ISO-8601 timestamp) so auditors can see when the sweep ran.
 *
 * The script is idempotent — rows where before === after are skipped.
 *
 * Memory safety (Task #289): every sweep iterates the source table in
 * keyset-paginated batches (`WHERE id > $cursor ORDER BY id ASC LIMIT N`)
 * rather than `SELECT … FROM <table>` in one shot. On large installations
 * this keeps Node's heap and the read lock bounded regardless of row count.
 *
 * Run with:
 *   npx tsx src/utils/redactHistoricalLogs.ts
 */

import fs from "fs";
import path from "path";
import { Pool } from "pg";
import {
  redactSensitiveFields,
  redactSecretLikeStrings,
  deepRedactSecretLikeStrings,
  isSensitiveField,
  REDACTED_SENTINEL,
  logEvent,
} from "./eventLogsDatabase";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const REDACT_DATE = new Date().toISOString();
const BREADCRUMB_KEY = "_redacted_at";

/**
 * Resolve the project-root `audit-evidence/` directory.
 *
 * In both execution contexts __dirname is exactly two levels below the
 * project root:
 *   - Direct CLI invocation via tsx: `<root>/src/utils/`  → `../../`
 *   - Mastra bundled dev server:     `<root>/.mastra/output/` → `../../`
 *
 * Using path.resolve(__dirname, '../..') therefore reliably reaches the
 * workspace root in either case without relying on package.json detection
 * (Mastra places its own package.json inside .mastra/output/).
 */
function resolveAuditEvidenceDir(): string {
  return path.resolve(__dirname, "../../audit-evidence");
}

/**
 * Default keyset-pagination batch size. 500 keeps each round trip under a
 * few MB of JSONB on realistic rows while still amortising network latency.
 * Exposed as an optional parameter on each sweep function so unit tests can
 * exercise the cursor-advance path with tiny fixtures.
 */
export const DEFAULT_SWEEP_BATCH_SIZE = 500;

/**
 * Tables the boot sweep operates on. Kept in one place so the readiness
 * gate (waitForTablesReady) and the sweep itself can never drift apart.
 *
 * Order is irrelevant — the readiness check only cares that *all* of these
 * resolve via `to_regclass()` before the sweep is allowed to run.
 */
export const REQUIRED_SWEEP_TABLES = [
  "event_logs",
  "nc_change_history",
  "capa_change_history",
  "ai_pending_actions",
] as const;

/**
 * Result of waitForTablesReady(). `ready=true` means every requested table
 * is visible to `to_regclass()` (i.e. exists in the current search_path)
 * and the sweep is safe to run. `ready=false` means we exhausted the
 * timeout before all tables appeared and the caller should skip the sweep
 * rather than emit a partially-populated `table_missing` audit record.
 */
export interface TablesReadyResult {
  ready: boolean;
  missing: string[];
  waitedMs: number;
  attempts: number;
}

/**
 * Default upper-bound the boot sweep waits for the four target tables to
 * appear. 60 s comfortably covers a cold-start where Mastra is still
 * creating its storage schema, while still failing the wait fast enough
 * that a genuine misconfiguration (wrong DATABASE_URL, dropped tables) is
 * surfaced in the boot log within a single boot cycle.
 */
export const DEFAULT_TABLE_READY_TIMEOUT_MS = 60_000;

/**
 * Default poll interval used by waitForTablesReady() between
 * `to_regclass()` lookups. 1 s keeps the boot path responsive on a fresh
 * deployment (sweep runs almost immediately after the last table is
 * created) without hammering the database with sub-second polls during
 * the steady-state case where everything is already there.
 */
export const DEFAULT_TABLE_READY_INTERVAL_MS = 1_000;

/**
 * Block until every requested table is resolvable via `to_regclass()` or
 * the timeout elapses.
 *
 * Why `to_regclass()` rather than `information_schema.tables` or a probe
 * `SELECT 1 FROM <t> LIMIT 0`?
 *   - It returns NULL (instead of erroring) for missing tables, so the
 *     boot sweep does not have to swallow `42P01` errors on every poll.
 *   - It honours the active `search_path`, matching what the sweep itself
 *     will see when it later issues `SELECT … FROM <table>`.
 *   - It is a cheap pg_class lookup — safe to call every second.
 *
 * Behaviour is best-effort: any unexpected error from the readiness
 * probe is logged and treated as "not ready yet" so the loop will retry
 * rather than crash the boot path.
 */
export async function waitForTablesReady(
  client: any,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    tables?: ReadonlyArray<string>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<TablesReadyResult> {
  const tables = options.tables ?? REQUIRED_SWEEP_TABLES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TABLE_READY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_TABLE_READY_INTERVAL_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  const startedAt = now();
  let attempts = 0;
  let lastMissing: string[] = [...tables];

  while (true) {
    attempts++;
    try {
      const placeholders = tables.map((_, i) => `$${i + 1}`).join(", ");
      const res = await client.query(
        `SELECT t AS name, to_regclass(t) IS NOT NULL AS present
           FROM unnest(ARRAY[${placeholders}]::text[]) AS t`,
        tables.map((t) => t),
      );
      const missing: string[] = (res.rows ?? [])
        .filter((r: any) => !r.present)
        .map((r: any) => r.name);
      lastMissing = missing;
      if (missing.length === 0) {
        return {
          ready: true,
          missing: [],
          waitedMs: now() - startedAt,
          attempts,
        };
      }
    } catch (probeErr) {
      // Treat any probe error as "not ready yet" so a transient failure
      // (e.g. connection reset during cold-start) does not prevent the
      // sweep from ever running. We still respect the timeout below.
      console.warn("[Redaction] Table-readiness probe failed:", probeErr);
    }

    if (now() - startedAt >= timeoutMs) {
      return {
        ready: false,
        missing: lastMissing,
        waitedMs: now() - startedAt,
        attempts,
      };
    }

    await sleep(intervalMs);
  }
}

/**
 * Result counters for the ai_pending_actions sweep. Reported in the
 * console output and the audit-log entry emitted by main().
 */
export interface AiPendingActionsSweepResult {
  scanned: number;
  payloadChanged: number;
  previewChanged: number;
  executionResultChanged: number;
  rowsUpdated: number;
}

function addBreadcrumb(obj: any): any {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    return { ...obj, [BREADCRUMB_KEY]: REDACT_DATE };
  }
  return obj;
}

export async function redactEventLogs(
  client: any,
  batchSize: number = DEFAULT_SWEEP_BATCH_SIZE,
): Promise<number> {
  let updated = 0;
  let cursor = 0;

  while (true) {
    const page = await client.query(
      `SELECT id, description, entity_name, old_value, new_value
         FROM event_logs
        WHERE id > $1
        ORDER BY id ASC
        LIMIT $2`,
      [cursor, batchSize],
    );

    if (!page.rows || page.rows.length === 0) break;

    for (const row of page.rows) {
      let description: string | null = row.description ?? null;
      let entityName: string | null = row.entity_name ?? null;
      let oldVal = row.old_value;
      let newVal = row.new_value;
      let changed = false;

      if (typeof description === "string" && description.length > 0) {
        const redacted = redactSecretLikeStrings(description) as string;
        if (redacted !== description) {
          description = redacted;
          changed = true;
        }
      }

      if (typeof entityName === "string" && entityName.length > 0) {
        const redacted = redactSecretLikeStrings(entityName) as string;
        if (redacted !== entityName) {
          entityName = redacted;
          changed = true;
        }
      }

      if (oldVal !== null && oldVal !== undefined) {
        const keyScrubbed = redactSensitiveFields(oldVal);
        const fullScrubbed = deepRedactSecretLikeStrings(keyScrubbed);
        if (JSON.stringify(fullScrubbed) !== JSON.stringify(oldVal)) {
          oldVal = addBreadcrumb(fullScrubbed);
          changed = true;
        }
      }

      if (newVal !== null && newVal !== undefined) {
        const keyScrubbed = redactSensitiveFields(newVal);
        const fullScrubbed = deepRedactSecretLikeStrings(keyScrubbed);
        if (JSON.stringify(fullScrubbed) !== JSON.stringify(newVal)) {
          newVal = addBreadcrumb(fullScrubbed);
          changed = true;
        }
      }

      if (changed) {
        await client.query(
          `UPDATE event_logs SET description = $1, entity_name = $2, old_value = $3, new_value = $4 WHERE id = $5`,
          [
            description,
            entityName,
            oldVal !== null && oldVal !== undefined
              ? JSON.stringify(oldVal)
              : null,
            newVal !== null && newVal !== undefined
              ? JSON.stringify(newVal)
              : null,
            row.id,
          ],
        );
        updated++;
      }
    }

    // Advance the keyset cursor to the largest id seen on this page so the
    // next SELECT skips already-scanned rows. Stop early when the page
    // returned fewer rows than the batch size — there is nothing left.
    cursor = page.rows[page.rows.length - 1].id;
    if (page.rows.length < batchSize) break;
  }

  return updated;
}

/**
 * Sweeps a `*_change_history` table (currently `nc_change_history` and
 * `capa_change_history`) for already-leaked secrets in the
 * `old_value`, `new_value`, and `change_reason` TEXT columns.
 *
 * Mirrors the two-layer protection that `logNCChange()` /
 * `logCAPAChange()` apply on every write (Task #99) so a database restore
 * from a pre-fix backup cannot reintroduce leaked credentials (Task #250):
 *
 *   1. KEY-BASED: when `field_changed` matches the sensitive-field deny
 *      list (`isSensitiveField`), the row's `old_value` and `new_value`
 *      are wholesale-replaced with `REDACTED_SENTINEL` — regardless of
 *      whether the stored value happens to look like a credential. This
 *      mirrors the write-path guard in `logNCChange`/`logCAPAChange`.
 *
 *   2. REGEX-BASED: for every row (sensitive field or not), the
 *      `change_reason` column AND any `old_value`/`new_value` strings on
 *      non-sensitive rows are passed through `redactSecretLikeStrings()`
 *      so that credential-shaped substrings (`sk_…`, `ghp_…`, `eyJ…`,
 *      bcrypt hashes, etc.) interpolated into prose are scrubbed. This
 *      catches rows written before Task #99 added the same defense to
 *      the write path, and rows whose `field_changed` is something
 *      innocuous like `description`/`note`/`summary` but happens to
 *      embed a leaked credential.
 *
 * Without layer #2 the post-restore sweep would silently leave any
 * pre-Task #99 row whose secret leaked through a non-sensitive field name
 * in place, defeating the purpose of running the sweep automatically after
 * every database restore.
 *
 * Idempotent: a row is only UPDATEd when at least one of its three
 * columns actually changes value, so re-running the sweep produces 0
 * updates on a clean table.
 *
 * Memory-safe: walks the table in keyset-paginated batches (Task #289).
 *
 * Used by Task #249 to retroactively sanitise existing
 * `nc_change_history` / `capa_change_history` rows that may contain
 * credentials written before Task #99 hardened the write path, and by
 * Task #250 to ensure the same coverage on every post-restore sweep.
 */
export async function redactChangeHistoryTable(
  client: any,
  tableName: string,
  batchSize: number = DEFAULT_SWEEP_BATCH_SIZE,
): Promise<number> {
  let updated = 0;
  let cursor = 0;

  while (true) {
    const page = await client.query(
      `SELECT id, field_changed, old_value, new_value, change_reason
         FROM ${tableName}
        WHERE id > $1
        ORDER BY id ASC
        LIMIT $2`,
      [cursor, batchSize],
    );

    if (!page.rows || page.rows.length === 0) break;

    for (const row of page.rows) {
      let oldVal: string | null = row.old_value;
      let newVal: string | null = row.new_value;
      let reason: string | null = row.change_reason;
      let changed = false;

      if (isSensitiveField(row.field_changed)) {
        // Layer 1 — key-based deny list: blanket-redact any non-null,
        // non-already-sentinel value.
        if (oldVal !== null && oldVal !== undefined && oldVal !== REDACTED_SENTINEL) {
          oldVal = REDACTED_SENTINEL;
          changed = true;
        }
        if (newVal !== null && newVal !== undefined && newVal !== REDACTED_SENTINEL) {
          newVal = REDACTED_SENTINEL;
          changed = true;
        }
      } else {
        // Layer 2 — regex scrubber on free-form values stored under a
        // non-sensitive field name. Non-string / null inputs short-circuit
        // to identity inside redactSecretLikeStrings.
        if (typeof oldVal === 'string' && oldVal.length > 0) {
          const scrubbed = redactSecretLikeStrings(oldVal) as string;
          if (scrubbed !== oldVal) {
            oldVal = scrubbed;
            changed = true;
          }
        }
        if (typeof newVal === 'string' && newVal.length > 0) {
          const scrubbed = redactSecretLikeStrings(newVal) as string;
          if (scrubbed !== newVal) {
            newVal = scrubbed;
            changed = true;
          }
        }
      }

      // change_reason is free-form prose on every row regardless of
      // field_changed, so it always gets the regex pass (matches the
      // write-time path in logNCChange / logCAPAChange).
      if (typeof reason === 'string' && reason.length > 0) {
        const scrubbed = redactSecretLikeStrings(reason) as string;
        if (scrubbed !== reason) {
          reason = scrubbed;
          changed = true;
        }
      }

      if (changed) {
        await client.query(
          `UPDATE ${tableName} SET old_value = $1, new_value = $2, change_reason = $3 WHERE id = $4`,
          [oldVal, newVal, reason, row.id],
        );
        updated++;
      }
    }

    cursor = page.rows[page.rows.length - 1].id;
    if (page.rows.length < batchSize) break;
  }

  return updated;
}

/**
 * Backfills the ai_pending_actions table:
 *
 *   - `payload` (JSONB)            -> key-based redactSensitiveFields
 *   - `execution_result` (JSONB)   -> key-based redactSensitiveFields
 *   - `payload_preview` (TEXT)     -> regex-based redactSecretLikeStrings
 *
 * The TEXT column is the free-form human-readable preview built by each
 * tool's `policy.buildPreview()` callback in `withApprovalGate.ts`. The
 * key-based helper is blind to credential-shaped substrings interpolated
 * into prose (sk-…, ghp_…, JWT, bcrypt, AWS access keys, etc.), so this
 * sweep additionally runs `redactSecretLikeStrings` over every existing
 * row to clear pre-fix leaks (Task #85).
 *
 * Idempotent: rows whose redacted form is byte-identical to the stored
 * value are skipped, so re-running produces 0 updates.
 */
export async function redactAiPendingActions(
  client: any,
  batchSize: number = DEFAULT_SWEEP_BATCH_SIZE,
): Promise<AiPendingActionsSweepResult> {
  let scanned = 0;
  let payloadChanged = 0;
  let previewChanged = 0;
  let executionResultChanged = 0;
  let rowsUpdated = 0;
  let cursor = 0;

  while (true) {
    const page = await client.query(
      `SELECT id, payload, payload_preview, execution_result
         FROM ai_pending_actions
        WHERE id > $1
        ORDER BY id ASC
        LIMIT $2`,
      [cursor, batchSize],
    );

    if (!page.rows || page.rows.length === 0) break;

    for (const row of page.rows) {
      scanned++;

      let payload = row.payload;
      let preview: string | null = row.payload_preview;
      let execResult = row.execution_result;

      let payloadDirty = false;
      let previewDirty = false;
      let execDirty = false;

      if (payload !== null && payload !== undefined) {
        const keyScrubbed = redactSensitiveFields(payload);
        const fullScrubbed = deepRedactSecretLikeStrings(keyScrubbed);
        if (JSON.stringify(fullScrubbed) !== JSON.stringify(payload)) {
          payload = fullScrubbed;
          payloadDirty = true;
        }
      }

      if (typeof preview === "string" && preview.length > 0) {
        const redactedPreview = redactSecretLikeStrings(preview) as string;
        if (redactedPreview !== preview) {
          preview = redactedPreview;
          previewDirty = true;
        }
      }

      if (execResult !== null && execResult !== undefined) {
        const keyScrubbed = redactSensitiveFields(execResult);
        const fullScrubbed = deepRedactSecretLikeStrings(keyScrubbed);
        if (JSON.stringify(fullScrubbed) !== JSON.stringify(execResult)) {
          execResult = fullScrubbed;
          execDirty = true;
        }
      }

      if (payloadDirty) payloadChanged++;
      if (previewDirty) previewChanged++;
      if (execDirty) executionResultChanged++;

      if (payloadDirty || previewDirty || execDirty) {
        await client.query(
          `UPDATE ai_pending_actions
              SET payload          = $1,
                  payload_preview  = $2,
                  execution_result = $3
            WHERE id = $4`,
          [
            payload !== null && payload !== undefined
              ? JSON.stringify(payload)
              : null,
            preview,
            execResult !== null && execResult !== undefined
              ? JSON.stringify(execResult)
              : null,
            row.id,
          ],
        );
        rowsUpdated++;
      }
    }

    cursor = page.rows[page.rows.length - 1].id;
    if (page.rows.length < batchSize) break;
  }

  return {
    scanned,
    payloadChanged,
    previewChanged,
    executionResultChanged,
    rowsUpdated,
  };
}

async function main() {
  const client = await pool.connect();
  try {
    console.log("[Redaction] Starting historical log redaction sweep...");
    console.log(`[Redaction] Sweep timestamp: ${REDACT_DATE}`);

    const result = await runSweepWithClient(client, REDACT_DATE);

    // Emit an immutable audit-log entry recording that the sweep ran. This
    // is the cross-table receipt auditors look for after the historical
    // backfill (ISO 27001 A.5.34, PDPL Art. 16, PCI DSS v4.0 §10.2.1).
    // Failure to write the audit row must NOT mask the sweep result, so
    // any error is logged and swallowed.
    try {
      await logEvent({
        actionType: "UPDATE",
        entityType: "SYSTEM",
        entityId: "ai_pending_actions",
        entityName: "Historical secret-redaction sweep",
        description:
          `Backfilled redactSecretLikeStrings + redactSensitiveFields across ` +
          `historical audit tables. event_logs=${result.event_logs_updated}, ` +
          `nc_change_history=${result.nc_change_history_updated}, ` +
          `capa_change_history=${result.capa_change_history_updated}, ` +
          `ai_pending_actions=${result.total_rows_updated - result.event_logs_updated - result.nc_change_history_updated - result.capa_change_history_updated} (rows updated).`,
        newValue: result,
        aiInvolved: false,
        severity: "INFO",
        module: "security/redaction-sweep",
      });
      console.log("[Redaction] Audit-log entry emitted for sweep run");
    } catch (auditErr) {
      console.error("[Redaction] Failed to emit audit-log entry:", auditErr);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Snake-case JSON snapshot of the ai_pending_actions sweep counters as
 * stored in SweepResult and last-sweep.json. Uses snake_case to match the
 * surrounding JSON structure (AiPendingActionsSweepResult uses camelCase
 * internally for TypeScript ergonomics).
 */
export interface AiPendingActionsSnapshot {
  scanned: number;
  payload_changed: number;
  payload_preview_changed: number;
  execution_result_changed: number;
  rows_updated: number;
}

/**
 * Full-sweep result returned by runSweepWithClient() and written to
 * audit-evidence/last-sweep.json by onBootRedactionSweep().
 */
export interface SweepResult {
  sweep_timestamp: string;
  event_logs_updated: number;
  nc_change_history_updated: number;
  capa_change_history_updated: number;
  ai_pending_actions: AiPendingActionsSnapshot | { skipped: string };
  total_rows_updated: number;
}

/**
 * Run the full redaction sweep against an already-open database client and
 * return structured counters. Does NOT commit its own transaction or close
 * the client — the caller controls the connection lifecycle.
 *
 * This is the function called both by main() (direct CLI invocation) and by
 * onBootRedactionSweep() (application-boot hook).
 */
export async function runSweepWithClient(
  client: any,
  sweepTimestamp: string,
): Promise<SweepResult> {
  const elCount = await redactEventLogs(client);
  console.log(`[Redaction] event_logs: ${elCount} rows updated`);

  let ncCount = 0;
  let capaCount = 0;
  let aiCount = 0;
  let aiResult: AiPendingActionsSweepResult | null = null;
  let aiSkipReason: string | null = null;

  try {
    ncCount = await redactChangeHistoryTable(client, "nc_change_history");
    console.log(`[Redaction] nc_change_history: ${ncCount} rows updated`);
  } catch (e: any) {
    if (e.code === "42P01") {
      console.log(
        "[Redaction] nc_change_history table does not exist — skipped",
      );
    } else {
      throw e;
    }
  }

  try {
    capaCount = await redactChangeHistoryTable(client, "capa_change_history");
    console.log(`[Redaction] capa_change_history: ${capaCount} rows updated`);
  } catch (e: any) {
    if (e.code === "42P01") {
      console.log(
        "[Redaction] capa_change_history table does not exist — skipped",
      );
    } else {
      throw e;
    }
  }

  try {
    aiResult = await redactAiPendingActions(client);
    aiCount = aiResult.rowsUpdated;
    console.log(
      `[Redaction] ai_pending_actions: ${aiResult.rowsUpdated} rows updated ` +
        `(scanned=${aiResult.scanned}, payload=${aiResult.payloadChanged}, ` +
        `payload_preview=${aiResult.previewChanged}, ` +
        `execution_result=${aiResult.executionResultChanged})`,
    );
  } catch (e: any) {
    if (e.code === "42P01") {
      aiSkipReason = "table_missing";
      console.log(
        "[Redaction] ai_pending_actions table does not exist — skipped",
      );
    } else {
      throw e;
    }
  }

  const total = elCount + ncCount + capaCount + aiCount;
  console.log(`[Redaction] Sweep complete. Total rows updated: ${total}`);

  return {
    sweep_timestamp: sweepTimestamp,
    event_logs_updated: elCount,
    nc_change_history_updated: ncCount,
    capa_change_history_updated: capaCount,
    ai_pending_actions: aiResult
      ? {
          scanned: aiResult.scanned,
          payload_changed: aiResult.payloadChanged,
          payload_preview_changed: aiResult.previewChanged,
          execution_result_changed: aiResult.executionResultChanged,
          rows_updated: aiResult.rowsUpdated,
        }
      : { skipped: aiSkipReason ?? "unknown" },
    total_rows_updated: total,
  };
}

/**
 * On-boot redaction sweep hook.
 *
 * Called once during application startup (see src/mastra/index.ts). It runs
 * the full redaction sweep and:
 *
 *   1. Emits a system-level audit-log entry via logEvent() (same as the CLI
 *      path) so the run is visible in the event_logs table.
 *   2. Writes a machine-readable JSON summary to
 *      audit-evidence/last-sweep.json so operators can see the most recent
 *      run's row counts at a glance without querying the database.
 *
 * The function NEVER throws — any error is caught and logged to stderr so
 * that a sweep failure cannot prevent the application from starting.
 *
 * The sweep is idempotent (rows already redacted are skipped), so running it
 * on every boot is safe. A fresh database restore that predates the deny-list
 * fix will therefore be automatically cleaned up on the very next startup.
 */
export async function onBootRedactionSweep(): Promise<void> {
  const g = globalThis as any;
  if (g.__walaplus_bootSweepDone) {
    console.log(
      "[Redaction] Boot sweep already ran this process — skipping duplicate call",
    );
    return;
  }

  const sweepTimestamp = new Date().toISOString();
  const bootPool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log("[Redaction] Boot sweep starting...");
    console.log(`[Redaction] Sweep timestamp: ${sweepTimestamp}`);

    const client = await bootPool.connect();
    let result: SweepResult;
    try {
      // Gate the sweep on table readiness. On a cold-start deployment the
      // application can begin before Mastra/Drizzle has finished creating
      // the audit tables, in which case the sweep would otherwise record
      // `skipped: table_missing` for every target. Polling `to_regclass`
      // until all four tables exist (or the timeout elapses) ensures the
      // sweep either runs against a fully-initialised schema or backs off
      // entirely without polluting last-sweep.json.
      const readiness = await waitForTablesReady(client);
      if (!readiness.ready) {
        console.warn(
          `[Redaction] Boot sweep aborted: tables not ready after ` +
            `${readiness.waitedMs}ms (${readiness.attempts} probes). ` +
            `Missing: ${readiness.missing.join(", ")}. ` +
            `Sweep will retry on the next boot.`,
        );
        // Do NOT mark __walaplus_bootSweepDone — the next boot should try
        // again. Likewise, do NOT write last-sweep.json or emit an audit
        // entry: there is no sweep result to record yet.
        return;
      }
      if (readiness.attempts > 1) {
        console.log(
          `[Redaction] Boot sweep tables ready after ${readiness.waitedMs}ms ` +
            `(${readiness.attempts} probes)`,
        );
      }
      result = await runSweepWithClient(client, sweepTimestamp);
    } finally {
      client.release();
    }

    // Mark as done only after the sweep data is in hand so that a transient
    // DB connection failure on the first attempt does not permanently
    // suppress future retries within the same process.
    g.__walaplus_bootSweepDone = true;

    try {
      await logEvent({
        actionType: "UPDATE",
        entityType: "SYSTEM",
        entityId: "boot_redaction_sweep",
        entityName: "Boot-time secret-redaction sweep",
        description:
          `Automatic on-boot redaction sweep completed. ` +
          `event_logs=${result.event_logs_updated}, ` +
          `nc_change_history=${result.nc_change_history_updated}, ` +
          `capa_change_history=${result.capa_change_history_updated}, ` +
          `ai_pending_actions=${result.total_rows_updated - result.event_logs_updated - result.nc_change_history_updated - result.capa_change_history_updated} (rows updated).`,
        newValue: result,
        aiInvolved: false,
        severity: "INFO",
        module: "security/redaction-sweep",
      });
      console.log("[Redaction] Boot sweep audit-log entry emitted");
    } catch (auditErr) {
      console.error(
        "[Redaction] Failed to emit boot sweep audit-log entry:",
        auditErr,
      );
    }

    try {
      const evidenceDir = resolveAuditEvidenceDir();
      if (!fs.existsSync(evidenceDir)) {
        fs.mkdirSync(evidenceDir, { recursive: true });
      }
      const summaryPath = path.join(evidenceDir, "last-sweep.json");
      fs.writeFileSync(
        summaryPath,
        JSON.stringify(result, null, 2) + "\n",
        "utf8",
      );
      console.log(`[Redaction] Boot sweep summary written to ${summaryPath}`);
    } catch (fileErr) {
      console.error(
        "[Redaction] Failed to write boot sweep summary file:",
        fileErr,
      );
    }
  } catch (err) {
    console.error(
      "[Redaction] Boot sweep failed — application startup continues:",
      err,
    );
  } finally {
    try {
      await bootPool.end();
    } catch {
      /* ignore */
    }
  }
}

// Only run the sweep when this file is invoked directly via `tsx` / `node`.
// When imported from a test or another module, `main()` must NOT auto-execute
// (it would open a real DB connection and try to logEvent against production).
const isDirectInvocation = (() => {
  try {
    const entry = process.argv[1] || "";
    return /redactHistoricalLogs(\.ts|\.js)?$/.test(entry);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((err) => {
    console.error("[Redaction] Fatal error:", err);
    process.exit(1);
  });
}
