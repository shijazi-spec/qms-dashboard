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
  detectCredentialLikeFields,
  isSensitiveField,
  REDACTED_SENTINEL,
  logEvent,
} from "./eventLogsDatabase";
import { redactPromptPreview, redactToolPayloadPreview } from "./aiTelemetry";

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
export function resolveAuditEvidenceDir(): string {
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

/**
 * Result counters for the ai_pending_actions credential-warnings backfill
 * sweep (Task #480). Reported in the console output and the audit-log
 * entry emitted by main() / onBootRedactionSweep().
 *
 *   - `scanned`         — rows whose `credential_warnings` column was
 *                         empty (`'[]'::jsonb`) at SELECT time. These
 *                         are the legacy / pre-Task-#477 rows the
 *                         backfill exists to cover.
 *   - `warningsAdded`   — total `CredentialWarning` entries written to
 *                         the column across all updated rows. Lets the
 *                         audit-log entry report the volume of newly
 *                         surfaced offending field paths, not just how
 *                         many rows changed.
 *   - `rowsUpdated`     — distinct rows that received a non-empty
 *                         credential_warnings array on this pass.
 */
export interface AiPendingActionsCredentialWarningsBackfillResult {
  scanned: number;
  rowsUpdated: number;
  warningsAdded: number;
}

/**
 * Result counters for the ai_call_metrics preview-column sweep
 * (Task #453). Reported in the console output and the audit-log
 * entry emitted by main() / onBootRedactionSweep().
 */
export interface AiCallMetricsSweepResult {
  scanned: number;
  promptPreviewChanged: number;
  toolInputPreviewChanged: number;
  toolOutputPreviewChanged: number;
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
 * Result counters for the NC/CAPA change-history sweep.
 *
 * Task #294: the sweep scrubs three columns per row, so reporting just
 * "rows updated" hides whether free-form `change_reason` notes also leaked
 * credentials. `changeReasonUpdated` is the per-column count of rows whose
 * `change_reason` text was rewritten (a subset of `rowsUpdated` — a single
 * row can change both value columns AND change_reason in one UPDATE).
 */
export interface ChangeHistorySweepResult {
  rowsUpdated: number;
  changeReasonUpdated: number;
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
 *
 * Returns a {@link ChangeHistorySweepResult} so the caller can report the
 * count of `change_reason` scrubs separately in audit-log entries
 * (Task #294 requirement).
 */
export async function redactChangeHistoryTable(
  client: any,
  tableName: string,
  batchSize: number = DEFAULT_SWEEP_BATCH_SIZE,
): Promise<ChangeHistorySweepResult> {
  let rowsUpdated = 0;
  let changeReasonUpdated = 0;
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
      let reason: string | null = row.change_reason ?? null;
      let valuesChanged = false;
      let reasonChanged = false;

      if (isSensitiveField(row.field_changed)) {
        // Layer 1 — key-based deny list: blanket-redact any non-null,
        // non-already-sentinel value. Preserve null (no leak risk in null)
        // and skip already-sentinel values so re-runs are idempotent.
        if (
          oldVal !== null &&
          oldVal !== undefined &&
          oldVal !== REDACTED_SENTINEL
        ) {
          oldVal = REDACTED_SENTINEL;
          valuesChanged = true;
        }
        if (
          newVal !== null &&
          newVal !== undefined &&
          newVal !== REDACTED_SENTINEL
        ) {
          newVal = REDACTED_SENTINEL;
          valuesChanged = true;
        }
      } else {
        // Layer 2 — regex scrubber on free-form values stored under a
        // non-sensitive field name (description, notes, …). The value
        // columns may contain a pasted credential from before Task #99
        // hardened the write path. Scrub each column independently and
        // only mark dirty when the scrubbed text differs byte-for-byte.
        // Non-string / null inputs short-circuit to identity inside
        // redactSecretLikeStrings.
        if (typeof oldVal === "string" && oldVal.length > 0) {
          const scrubbed = redactSecretLikeStrings(oldVal) as string;
          if (scrubbed !== oldVal) {
            oldVal = scrubbed;
            valuesChanged = true;
          }
        }
        if (typeof newVal === "string" && newVal.length > 0) {
          const scrubbed = redactSecretLikeStrings(newVal) as string;
          if (scrubbed !== newVal) {
            newVal = scrubbed;
            valuesChanged = true;
          }
        }
      }

      // change_reason is operator-supplied free-form prose on every row
      // regardless of field_changed, so it always gets the regex pass
      // (matches the write-time path in logNCChange / logCAPAChange).
      if (typeof reason === "string" && reason.length > 0) {
        const scrubbed = redactSecretLikeStrings(reason) as string;
        if (scrubbed !== reason) {
          reason = scrubbed;
          reasonChanged = true;
        }
      }

      if (valuesChanged || reasonChanged) {
        await client.query(
          `UPDATE ${tableName} SET old_value = $1, new_value = $2, change_reason = $3 WHERE id = $4`,
          [oldVal, newVal, reason, row.id],
        );
        rowsUpdated++;
        if (reasonChanged) changeReasonUpdated++;
      }
    }

    cursor = page.rows[page.rows.length - 1].id;
    if (page.rows.length < batchSize) break;
  }

  return { rowsUpdated, changeReasonUpdated };
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

/**
 * Task #480: backfills `ai_pending_actions.credential_warnings` for rows
 * that pre-date the Task #477 detector.
 *
 * Why this exists
 * ---------------
 * Task #477 wired `detectCredentialLikeFields()` into the live submission
 * path (`enqueuePendingAction()` in `aiApprovalDatabase.ts`) so every new
 * approval row records — alongside the redacted payload — a structured
 * list of fields whose values look like credentials. Rows enqueued
 * BEFORE that change have an empty array (`'[]'::jsonb`, the column
 * default), so the operator approval UI shows no red warning banner on
 * them even when the persisted payload still contains tell-tale
 * token-prefix shapes the redactor missed.
 *
 * What this sweep does
 * --------------------
 * For every row whose `credential_warnings` column is empty, run the
 * SAME detector used at submission time over the persisted (redacted)
 * `payload` + `payload_preview` and write the resulting warnings back.
 * Detection happens AFTER the in-process redaction sweep
 * (`redactAiPendingActions`) above so the warnings reflect what is
 * actually still on disk after every known cleanup has run — i.e. the
 * "shapes the redactor missed" the task is targeting.
 *
 * Idempotency
 * -----------
 *   - The `WHERE credential_warnings = '[]'::jsonb` filter naturally
 *     excludes rows already covered by the live path or by a previous
 *     backfill pass, so re-runs ignore them.
 *   - The UPDATE re-asserts the same `'[]'::jsonb` predicate so a
 *     concurrent live INSERT that happens between SELECT and UPDATE
 *     cannot have its newer non-empty warnings overwritten by the sweep.
 *   - Rows whose detector pass returns 0 warnings are not UPDATEd at all
 *     — the column stays at the default `'[]'`, matching what the live
 *     path would have written for that payload.
 *
 * Memory-safe: walks the table in keyset-paginated batches (Task #289).
 */
export async function backfillAiPendingActionsCredentialWarnings(
  client: any,
  batchSize: number = DEFAULT_SWEEP_BATCH_SIZE,
): Promise<AiPendingActionsCredentialWarningsBackfillResult> {
  let scanned = 0;
  let rowsUpdated = 0;
  let warningsAdded = 0;
  let cursor = 0;

  while (true) {
    const page = await client.query(
      `SELECT id, payload, payload_preview
         FROM ai_pending_actions
        WHERE id > $1
          AND credential_warnings = '[]'::jsonb
        ORDER BY id ASC
        LIMIT $2`,
      [cursor, batchSize],
    );

    if (!page.rows || page.rows.length === 0) break;

    for (const row of page.rows) {
      scanned++;

      const preview =
        typeof row.payload_preview === "string" ? row.payload_preview : null;
      const warnings = detectCredentialLikeFields(row.payload, preview);

      if (warnings.length > 0) {
        // Re-assert the empty-array predicate in the UPDATE so a
        // concurrent live INSERT (which would have populated the
        // column itself) cannot have its warnings clobbered by the
        // sweep. This is belt-and-braces — `enqueuePendingAction()`
        // never UPDATEs an existing row's credential_warnings — but
        // it keeps the sweep safe under any future write path that
        // might.
        const res = await client.query(
          `UPDATE ai_pending_actions
              SET credential_warnings = $1
            WHERE id = $2
              AND credential_warnings = '[]'::jsonb`,
          [JSON.stringify(warnings), row.id],
        );
        if ((res.rowCount ?? 0) > 0) {
          rowsUpdated++;
          warningsAdded += warnings.length;
        }
      }
    }

    cursor = page.rows[page.rows.length - 1].id;
    if (page.rows.length < batchSize) break;
  }

  return { scanned, rowsUpdated, warningsAdded };
}

/**
 * Backfill the ai_call_metrics preview columns (Task #453).
 *
 *   - `prompt_preview`        (TEXT) -> redactPromptPreview
 *   - `tool_input_preview`    (TEXT) -> redactToolPayloadPreview
 *   - `tool_output_preview`   (TEXT) -> redactToolPayloadPreview
 *
 * Tasks #109 and #276 added redaction to the WRITE path of these columns,
 * but rows persisted before those fixes shipped may still contain raw
 * sk-…, ghp_…, JWT, bcrypt, or AKIA/ASIA tokens. This sweep re-runs the
 * exact same redactor functions used by the write path over every
 * existing row in keyset-paginated batches, writes the cleaned values
 * back, and reports per-column counters.
 *
 * Idempotent: rows whose redacted form is byte-identical to the stored
 * value are skipped, so re-running produces 0 updates.
 */
export async function redactAiCallMetrics(
  client: any,
  batchSize: number = DEFAULT_SWEEP_BATCH_SIZE,
): Promise<AiCallMetricsSweepResult> {
  let scanned = 0;
  let promptPreviewChanged = 0;
  let toolInputPreviewChanged = 0;
  let toolOutputPreviewChanged = 0;
  let rowsUpdated = 0;
  let cursor = 0;

  while (true) {
    const page = await client.query(
      `SELECT id, prompt_preview, tool_input_preview, tool_output_preview
         FROM ai_call_metrics
        WHERE id > $1
        ORDER BY id ASC
        LIMIT $2`,
      [cursor, batchSize],
    );

    if (!page.rows || page.rows.length === 0) break;

    for (const row of page.rows) {
      scanned++;

      let promptPreview: string | null = row.prompt_preview ?? null;
      let toolInputPreview: string | null = row.tool_input_preview ?? null;
      let toolOutputPreview: string | null = row.tool_output_preview ?? null;

      let promptDirty = false;
      let inputDirty = false;
      let outputDirty = false;

      if (typeof promptPreview === "string" && promptPreview.length > 0) {
        const cleaned = redactPromptPreview(promptPreview);
        if (cleaned !== promptPreview) {
          promptPreview = cleaned;
          promptDirty = true;
        }
      }

      if (typeof toolInputPreview === "string" && toolInputPreview.length > 0) {
        const cleaned = redactToolPayloadPreview(toolInputPreview) ?? null;
        if (cleaned !== toolInputPreview) {
          toolInputPreview = cleaned;
          inputDirty = true;
        }
      }

      if (
        typeof toolOutputPreview === "string" &&
        toolOutputPreview.length > 0
      ) {
        const cleaned = redactToolPayloadPreview(toolOutputPreview) ?? null;
        if (cleaned !== toolOutputPreview) {
          toolOutputPreview = cleaned;
          outputDirty = true;
        }
      }

      if (promptDirty) promptPreviewChanged++;
      if (inputDirty) toolInputPreviewChanged++;
      if (outputDirty) toolOutputPreviewChanged++;

      if (promptDirty || inputDirty || outputDirty) {
        // Task #467: stamp `previews_redacted_at = NOW()` alongside the
        // scrubbed columns so the AI Operations call-detail UI can show
        // an info badge ("Preview redacted by historical sweep on …")
        // explaining why the preview differs from what the call
        // originally wrote. Idempotency is preserved because we only
        // reach this UPDATE branch when at least one preview column
        // actually changed — a row that was already clean (with or
        // without an existing timestamp) is skipped above and never
        // re-stamped.
        await client.query(
          `UPDATE ai_call_metrics
              SET prompt_preview       = $1,
                  tool_input_preview   = $2,
                  tool_output_preview  = $3,
                  previews_redacted_at = NOW()
            WHERE id = $4`,
          [promptPreview, toolInputPreview, toolOutputPreview, row.id],
        );
        rowsUpdated++;
      }
    }

    cursor = page.rows[page.rows.length - 1].id;
    if (page.rows.length < batchSize) break;
  }

  return {
    scanned,
    promptPreviewChanged,
    toolInputPreviewChanged,
    toolOutputPreviewChanged,
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
          `nc_change_history=${result.nc_change_history_updated} ` +
          `(change_reason=${result.nc_change_history_change_reason_updated}), ` +
          `capa_change_history=${result.capa_change_history_updated} ` +
          `(change_reason=${result.capa_change_history_change_reason_updated}), ` +
          `ai_pending_actions=${"rows_updated" in result.ai_pending_actions ? result.ai_pending_actions.rows_updated : 0}, ` +
          `ai_pending_actions_credential_warnings=` +
          `${"rows_updated" in result.ai_pending_actions_credential_warnings ? result.ai_pending_actions_credential_warnings.rows_updated : 0} ` +
          `(scanned=${"scanned" in result.ai_pending_actions_credential_warnings ? result.ai_pending_actions_credential_warnings.scanned : 0}, ` +
          `warnings_added=${"warnings_added" in result.ai_pending_actions_credential_warnings ? result.ai_pending_actions_credential_warnings.warnings_added : 0}), ` +
          `ai_call_metrics=${"rows_updated" in result.ai_call_metrics ? result.ai_call_metrics.rows_updated : 0} (rows updated).`,
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
 * Snake-case JSON snapshot of the ai_pending_actions credential-warnings
 * backfill counters (Task #480) as stored in SweepResult and
 * last-sweep.json. Snake-case to match the surrounding JSON structure.
 */
export interface AiPendingActionsCredentialWarningsBackfillSnapshot {
  scanned: number;
  rows_updated: number;
  warnings_added: number;
}

/**
 * Snake-case JSON snapshot of the ai_call_metrics sweep counters as
 * stored in SweepResult and last-sweep.json. (Task #453.)
 */
export interface AiCallMetricsSnapshot {
  scanned: number;
  prompt_preview_changed: number;
  tool_input_preview_changed: number;
  tool_output_preview_changed: number;
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
  nc_change_history_change_reason_updated: number;
  capa_change_history_updated: number;
  capa_change_history_change_reason_updated: number;
  ai_pending_actions: AiPendingActionsSnapshot | { skipped: string };
  /**
   * Task #480 — credential-warnings backfill counters for the
   * ai_pending_actions table. Tracked separately from
   * `ai_pending_actions` (which is the in-place secret-redaction
   * sweep) because the two phases have different idempotency semantics
   * and different audit-evidence value. `{ skipped: ... }` when the
   * table itself is missing (cold-start race already handled by
   * waitForTablesReady, but kept symmetric for direct CLI invocations).
   */
  ai_pending_actions_credential_warnings:
    | AiPendingActionsCredentialWarningsBackfillSnapshot
    | { skipped: string };
  ai_call_metrics: AiCallMetricsSnapshot | { skipped: string };
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
  let ncReasonCount = 0;
  let capaCount = 0;
  let capaReasonCount = 0;
  let aiCount = 0;
  let aiResult: AiPendingActionsSweepResult | null = null;
  let aiSkipReason: string | null = null;
  let metricsCount = 0;
  let metricsResult: AiCallMetricsSweepResult | null = null;
  let metricsSkipReason: string | null = null;
  let credWarnResult: AiPendingActionsCredentialWarningsBackfillResult | null =
    null;
  let credWarnSkipReason: string | null = null;

  try {
    const ncResult = await redactChangeHistoryTable(
      client,
      "nc_change_history",
    );
    ncCount = ncResult.rowsUpdated;
    ncReasonCount = ncResult.changeReasonUpdated;
    console.log(
      `[Redaction] nc_change_history: ${ncCount} rows updated ` +
        `(change_reason scrubs=${ncReasonCount})`,
    );
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
    const capaResult = await redactChangeHistoryTable(
      client,
      "capa_change_history",
    );
    capaCount = capaResult.rowsUpdated;
    capaReasonCount = capaResult.changeReasonUpdated;
    console.log(
      `[Redaction] capa_change_history: ${capaCount} rows updated ` +
        `(change_reason scrubs=${capaReasonCount})`,
    );
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

  // Task #480: backfill credential_warnings on legacy ai_pending_actions
  // rows. Runs AFTER `redactAiPendingActions` above so the detector sees
  // the post-redaction payload that the operator will actually be looking
  // at — i.e. it surfaces tell-tale shapes the redactor missed.
  try {
    credWarnResult = await backfillAiPendingActionsCredentialWarnings(client);
    console.log(
      `[Redaction] ai_pending_actions.credential_warnings backfill: ` +
        `${credWarnResult.rowsUpdated} rows flagged ` +
        `(scanned=${credWarnResult.scanned}, ` +
        `warnings_added=${credWarnResult.warningsAdded})`,
    );
  } catch (e: any) {
    if (e.code === "42P01") {
      credWarnSkipReason = "table_missing";
      console.log(
        "[Redaction] ai_pending_actions table does not exist — credential_warnings backfill skipped",
      );
    } else {
      throw e;
    }
  }

  try {
    metricsResult = await redactAiCallMetrics(client);
    metricsCount = metricsResult.rowsUpdated;
    console.log(
      `[Redaction] ai_call_metrics: ${metricsResult.rowsUpdated} rows updated ` +
        `(scanned=${metricsResult.scanned}, ` +
        `prompt_preview=${metricsResult.promptPreviewChanged}, ` +
        `tool_input_preview=${metricsResult.toolInputPreviewChanged}, ` +
        `tool_output_preview=${metricsResult.toolOutputPreviewChanged})`,
    );
  } catch (e: any) {
    if (e.code === "42P01") {
      metricsSkipReason = "table_missing";
      console.log("[Redaction] ai_call_metrics table does not exist — skipped");
    } else {
      throw e;
    }
  }

  // Task #480: include the credential-warnings backfill in the aggregate
  // so audit-evidence reports do not undercount sweep activity.
  const credWarnCount = credWarnResult?.rowsUpdated ?? 0;
  const total =
    elCount + ncCount + capaCount + aiCount + credWarnCount + metricsCount;
  console.log(`[Redaction] Sweep complete. Total rows updated: ${total}`);

  return {
    sweep_timestamp: sweepTimestamp,
    event_logs_updated: elCount,
    nc_change_history_updated: ncCount,
    nc_change_history_change_reason_updated: ncReasonCount,
    capa_change_history_updated: capaCount,
    capa_change_history_change_reason_updated: capaReasonCount,
    ai_pending_actions: aiResult
      ? {
          scanned: aiResult.scanned,
          payload_changed: aiResult.payloadChanged,
          payload_preview_changed: aiResult.previewChanged,
          execution_result_changed: aiResult.executionResultChanged,
          rows_updated: aiResult.rowsUpdated,
        }
      : { skipped: aiSkipReason ?? "unknown" },
    ai_pending_actions_credential_warnings: credWarnResult
      ? {
          scanned: credWarnResult.scanned,
          rows_updated: credWarnResult.rowsUpdated,
          warnings_added: credWarnResult.warningsAdded,
        }
      : { skipped: credWarnSkipReason ?? "unknown" },
    ai_call_metrics: metricsResult
      ? {
          scanned: metricsResult.scanned,
          prompt_preview_changed: metricsResult.promptPreviewChanged,
          tool_input_preview_changed: metricsResult.toolInputPreviewChanged,
          tool_output_preview_changed: metricsResult.toolOutputPreviewChanged,
          rows_updated: metricsResult.rowsUpdated,
        }
      : { skipped: metricsSkipReason ?? "unknown" },
    total_rows_updated: total,
  };
}

/**
 * Per-table counters extracted from a {@link SweepResult} for the alert
 * dispatcher. Kept in this stable shape so the alert payload (notification
 * `message`, Slack body) is independent of internal `SweepResult` field
 * renames.
 *
 * Only the four surfaces called out in Task #462 trigger the alert — the
 * NC/CAPA `change_reason` sub-counters, the credential-warnings backfill,
 * and the `ai_call_metrics` preview backfill are diagnostic and would
 * otherwise produce noise on every boot they re-scan a still-dirty table.
 */
export interface PostRestoreSweepAlertTriggerCounts {
  event_logs: number;
  nc_change_history: number;
  capa_change_history: number;
  ai_pending_actions: number;
}

/**
 * Outcome of {@link dispatchPostRestoreSweepAlert}. Used by the boot sweep
 * for logging and by unit tests to assert dispatcher behaviour without
 * standing up a real notifications/Slack pipeline.
 */
export interface PostRestoreSweepAlertOutcome {
  /**
   * `true` iff at least one of the four monitored counters was non-zero
   * AND a delivery attempt was made (regardless of whether each individual
   * channel succeeded).
   */
  dispatched: boolean;
  /** Reason a clean sweep was suppressed — populated only when `dispatched=false`. */
  skippedReason?: "all_counts_zero";
  /** Per-table counts that triggered the alert (empty when not dispatched). */
  triggers: PostRestoreSweepAlertTriggerCounts;
  /** Channels the dispatcher attempted to deliver on this run. */
  channelsAttempted: Array<"platform_notification" | "slack_webhook">;
  /** Subset of `channelsAttempted` that completed without throwing. */
  channelsSucceeded: Array<"platform_notification" | "slack_webhook">;
}

/**
 * Optional dependency overrides for {@link dispatchPostRestoreSweepAlert}.
 * Production callers leave these undefined — the defaults dynamically
 * import `notificationHub.createNotification` and use the global `fetch`
 * + `process.env`. Unit tests pass stubs to assert the dispatcher's
 * behaviour without touching real notification or webhook destinations.
 */
export interface PostRestoreSweepAlertDeps {
  createNotification?: (notif: Record<string, unknown>) => Promise<unknown>;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Extract the four monitored counters from a {@link SweepResult}.
 *
 * `ai_pending_actions` is a discriminated union (`{ skipped: ... }` when
 * the table was missing on a cold-start race), so we narrow with `'rows_updated' in …` and treat the skipped case as zero — a missing
 * table genuinely had no rewrites to alert on.
 */
export function extractPostRestoreSweepAlertCounts(
  result: SweepResult,
): PostRestoreSweepAlertTriggerCounts {
  const aiCount =
    "rows_updated" in result.ai_pending_actions
      ? result.ai_pending_actions.rows_updated
      : 0;
  return {
    event_logs: result.event_logs_updated,
    nc_change_history: result.nc_change_history_updated,
    capa_change_history: result.capa_change_history_updated,
    ai_pending_actions: aiCount,
  };
}

/**
 * Dispatch an operator-facing alert when the post-restore redaction sweep
 * actually rewrote rows (Task #462).
 *
 * A non-zero `nc_change_history_updated` or `capa_change_history_updated`
 * is a strong signal that a database restore from a pre-Task-#99 backup
 * just reintroduced leaked credentials — exactly the scenario the sweep
 * is designed to catch. Without an active alert, the only post-fact
 * evidence is the `audit-evidence/last-sweep.json` file and a single
 * INFO-severity `event_logs` row, neither of which pages anyone.
 *
 * Behaviour:
 *
 *   - When **all four** monitored counts are zero, the function returns
 *     immediately without emitting anything. A clean sweep stays silent
 *     so on-call is not paged on every boot.
 *   - When any count is non-zero, the function dispatches the alert via:
 *       1. The platform notification hub (`createNotification`,
 *          dynamically imported so this module stays usable in pure-CLI
 *          contexts that have no DB-backed notifications table).
 *       2. The Slack webhook at `SLACK_WEBHOOK_URL`, mirroring the
 *          `ai-cost-summary` cron pattern in
 *          `src/mastra/inngest/index.ts`. Skipped silently when the env
 *          var is unset (parity with that cron).
 *
 * Each channel is attempted independently — a Slack outage must not
 * suppress the in-app notification and vice-versa. Failures are logged
 * but never re-thrown: the boot path must not crash because the alert
 * pipeline is degraded.
 *
 * The alert payload always includes the per-table counts and the sweep
 * timestamp so on-call can immediately tell which surface area was
 * affected without opening the dashboard.
 */
export async function dispatchPostRestoreSweepAlert(
  result: SweepResult,
  deps: PostRestoreSweepAlertDeps = {},
): Promise<PostRestoreSweepAlertOutcome> {
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? console;
  const triggers = extractPostRestoreSweepAlertCounts(result);

  const totalTriggered =
    triggers.event_logs +
    triggers.nc_change_history +
    triggers.capa_change_history +
    triggers.ai_pending_actions;

  if (totalTriggered === 0) {
    return {
      dispatched: false,
      skippedReason: "all_counts_zero",
      triggers,
      channelsAttempted: [],
      channelsSucceeded: [],
    };
  }

  // Headline kept neutral ("historical rows") because the same dispatcher
  // fires when only `event_logs_updated` or `ai_pending_actions.rows_updated`
  // is non-zero — saying "change-history rows" would be misleading for
  // those cases. The per-table counts in the body and the explicit
  // change-history hint make the source unambiguous to responders.
  const headline = "Post-restore redaction sweep rewrote historical rows";
  const detailLine =
    `event_logs=${triggers.event_logs}, ` +
    `nc_change_history=${triggers.nc_change_history}, ` +
    `capa_change_history=${triggers.capa_change_history}, ` +
    `ai_pending_actions=${triggers.ai_pending_actions}`;
  const message =
    `Boot-time redaction sweep at ${result.sweep_timestamp} rewrote one or ` +
    `more historical rows. A non-zero count on nc_change_history or ` +
    `capa_change_history usually means a database restore from a pre-fix ` +
    `backup reintroduced leaked credentials — investigate the source ` +
    `backup immediately. Per-table counts: ${detailLine}.`;

  const channelsAttempted: PostRestoreSweepAlertOutcome["channelsAttempted"] =
    [];
  const channelsSucceeded: PostRestoreSweepAlertOutcome["channelsSucceeded"] =
    [];

  // Channel 1 — platform notification hub.
  channelsAttempted.push("platform_notification");
  try {
    const createNotification =
      deps.createNotification ??
      (await import("./notificationHub")).createNotification;
    await createNotification({
      module: "security/redaction-sweep",
      priority: "critical",
      channel: "in_app",
      title: headline,
      message,
      related_entity_type: "SYSTEM",
      related_entity_id: "boot_redaction_sweep",
      action_url: "/audit-logs",
    });
    channelsSucceeded.push("platform_notification");
  } catch (notifErr) {
    logger.warn?.(
      "[Redaction] Post-restore sweep alert: platform notification failed:",
      notifErr,
    );
  }

  // Channel 2 — Slack webhook (mirrors the ai-cost-summary cron pattern).
  const slackUrl = env.SLACK_WEBHOOK_URL;
  if (slackUrl) {
    channelsAttempted.push("slack_webhook");
    try {
      const fetchImpl = deps.fetch ?? fetch;
      const slackBody = {
        text:
          `:rotating_light: *${headline}*\n` +
          `Sweep timestamp: \`${result.sweep_timestamp}\`\n` +
          `Per-table counts: \`${detailLine}\`\n` +
          `A non-zero \`nc_change_history\` or \`capa_change_history\` ` +
          `count usually means a database restore from a pre-fix backup ` +
          `reintroduced leaked credentials — investigate the source ` +
          `backup immediately.`,
      };
      const res = await fetchImpl(slackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slackBody),
      });
      // `fetch` only throws on network errors; a 4xx/5xx response
      // resolves with `ok=false`. Treat HTTP failure as a delivery
      // failure so the outcome accurately reflects what landed in Slack.
      if (res && typeof res === "object" && "ok" in res && !res.ok) {
        logger.warn?.(
          `[Redaction] Post-restore sweep alert: Slack webhook returned ` +
            `HTTP ${"status" in res ? (res as { status: number }).status : "?"}`,
        );
      } else {
        channelsSucceeded.push("slack_webhook");
      }
    } catch (slackErr) {
      logger.warn?.(
        "[Redaction] Post-restore sweep alert: Slack webhook failed:",
        slackErr,
      );
    }
  }

  logger.log?.(
    `[Redaction] Post-restore sweep alert dispatched ` +
      `(triggers: ${detailLine}; channels succeeded: ` +
      `${channelsSucceeded.join(",") || "none"})`,
  );

  return {
    dispatched: true,
    triggers,
    channelsAttempted,
    channelsSucceeded,
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
 *   3. Dispatches an operator-facing alert (Task #462) when any of the
 *      four monitored counters is non-zero — see
 *      {@link dispatchPostRestoreSweepAlert}.
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
          `nc_change_history=${result.nc_change_history_updated} ` +
          `(change_reason=${result.nc_change_history_change_reason_updated}), ` +
          `capa_change_history=${result.capa_change_history_updated} ` +
          `(change_reason=${result.capa_change_history_change_reason_updated}), ` +
          `ai_pending_actions=${"rows_updated" in result.ai_pending_actions ? result.ai_pending_actions.rows_updated : 0}, ` +
          `ai_pending_actions_credential_warnings=` +
          `${"rows_updated" in result.ai_pending_actions_credential_warnings ? result.ai_pending_actions_credential_warnings.rows_updated : 0} ` +
          `(scanned=${"scanned" in result.ai_pending_actions_credential_warnings ? result.ai_pending_actions_credential_warnings.scanned : 0}, ` +
          `warnings_added=${"warnings_added" in result.ai_pending_actions_credential_warnings ? result.ai_pending_actions_credential_warnings.warnings_added : 0}), ` +
          `ai_call_metrics=${"rows_updated" in result.ai_call_metrics ? result.ai_call_metrics.rows_updated : 0} (rows updated).`,
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

    // Task #462: actively page security/ops when the sweep actually
    // rewrote rows. A clean sweep stays silent (see
    // dispatchPostRestoreSweepAlert). The dispatcher swallows its own
    // delivery errors, but we still wrap it so an unexpected throw cannot
    // take down the boot path.
    try {
      await dispatchPostRestoreSweepAlert(result);
    } catch (alertErr) {
      console.error(
        "[Redaction] Failed to dispatch post-restore sweep alert:",
        alertErr,
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
