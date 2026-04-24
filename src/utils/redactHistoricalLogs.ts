/**
 * One-off migration: scan existing event_logs and change_history rows for
 * sensitive field values and rewrite them to ***REDACTED***.
 *
 * Uses the SAME deny-list logic as redactSensitiveFields() — imported from
 * eventLogsDatabase.ts — so there is no duplication or drift risk.
 *
 * Detection strategy: apply redactSensitiveFields() to the parsed payload and
 * compare the stringified result against the original. If they differ, the row
 * needs updating. This correctly handles partially-redacted rows that may still
 * contain additional unmasked sensitive keys.
 *
 * Each updated event_logs JSON object gains a `_redacted_at` breadcrumb key
 * (ISO-8601 timestamp) so auditors can see when the sweep ran.
 *
 * The script is idempotent — rows where before === after are skipped.
 *
 * Run with:
 *   npx tsx src/utils/redactHistoricalLogs.ts
 */

import { Pool } from 'pg';
import {
  redactSensitiveFields,
  redactSecretLikeStrings,
  isSensitiveField,
  REDACTED_SENTINEL,
  logEvent,
} from './eventLogsDatabase';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const REDACT_DATE = new Date().toISOString();
const BREADCRUMB_KEY = '_redacted_at';

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
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    return { ...obj, [BREADCRUMB_KEY]: REDACT_DATE };
  }
  return obj;
}

async function redactEventLogs(client: any): Promise<number> {
  const rows = await client.query(`
    SELECT id, old_value, new_value
    FROM event_logs
    WHERE old_value IS NOT NULL OR new_value IS NOT NULL
  `);

  let updated = 0;
  for (const row of rows.rows) {
    let oldVal = row.old_value;
    let newVal = row.new_value;
    let changed = false;

    if (oldVal !== null) {
      const redacted = redactSensitiveFields(oldVal);
      if (JSON.stringify(redacted) !== JSON.stringify(oldVal)) {
        oldVal = addBreadcrumb(redacted);
        changed = true;
      }
    }

    if (newVal !== null) {
      const redacted = redactSensitiveFields(newVal);
      if (JSON.stringify(redacted) !== JSON.stringify(newVal)) {
        newVal = addBreadcrumb(redacted);
        changed = true;
      }
    }

    if (changed) {
      await client.query(
        `UPDATE event_logs SET old_value = $1, new_value = $2 WHERE id = $3`,
        [
          oldVal !== null ? JSON.stringify(oldVal) : null,
          newVal !== null ? JSON.stringify(newVal) : null,
          row.id,
        ]
      );
      updated++;
    }
  }
  return updated;
}

async function redactChangeHistoryTable(client: any, tableName: string): Promise<number> {
  const rows = await client.query(
    `SELECT id, field_changed, old_value, new_value FROM ${tableName}`
  );

  let updated = 0;
  for (const row of rows.rows) {
    if (!isSensitiveField(row.field_changed)) continue;

    const oldAlready = row.old_value === REDACTED_SENTINEL;
    const newAlready = row.new_value === REDACTED_SENTINEL;
    if (oldAlready && newAlready) continue;

    await client.query(
      `UPDATE ${tableName} SET old_value = $1, new_value = $2 WHERE id = $3`,
      [REDACTED_SENTINEL, REDACTED_SENTINEL, row.id]
    );
    updated++;
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
): Promise<AiPendingActionsSweepResult> {
  const rows = await client.query(
    `SELECT id, payload, payload_preview, execution_result FROM ai_pending_actions`,
  );

  let scanned = 0;
  let payloadChanged = 0;
  let previewChanged = 0;
  let executionResultChanged = 0;
  let rowsUpdated = 0;

  for (const row of rows.rows) {
    scanned++;

    let payload = row.payload;
    let preview: string | null = row.payload_preview;
    let execResult = row.execution_result;

    let payloadDirty = false;
    let previewDirty = false;
    let execDirty = false;

    if (payload !== null && payload !== undefined) {
      const redacted = redactSensitiveFields(payload);
      if (JSON.stringify(redacted) !== JSON.stringify(payload)) {
        payload = redacted;
        payloadDirty = true;
      }
    }

    if (typeof preview === 'string' && preview.length > 0) {
      const redactedPreview = redactSecretLikeStrings(preview) as string;
      if (redactedPreview !== preview) {
        preview = redactedPreview;
        previewDirty = true;
      }
    }

    if (execResult !== null && execResult !== undefined) {
      const redacted = redactSensitiveFields(execResult);
      if (JSON.stringify(redacted) !== JSON.stringify(execResult)) {
        execResult = redacted;
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
          payload !== null && payload !== undefined ? JSON.stringify(payload) : null,
          preview,
          execResult !== null && execResult !== undefined ? JSON.stringify(execResult) : null,
          row.id,
        ],
      );
      rowsUpdated++;
    }
  }

  return { scanned, payloadChanged, previewChanged, executionResultChanged, rowsUpdated };
}

async function main() {
  const client = await pool.connect();
  try {
    console.log('[Redaction] Starting historical log redaction sweep...');
    console.log(`[Redaction] Sweep timestamp: ${REDACT_DATE}`);

    const elCount = await redactEventLogs(client);
    console.log(`[Redaction] event_logs: ${elCount} rows updated`);

    let ncCount = 0;
    let capaCount = 0;
    let aiCount = 0;

    try {
      ncCount = await redactChangeHistoryTable(client, 'nc_change_history');
      console.log(`[Redaction] nc_change_history: ${ncCount} rows updated`);
    } catch (e: any) {
      if (e.code === '42P01') {
        console.log('[Redaction] nc_change_history table does not exist — skipped');
      } else { throw e; }
    }

    try {
      capaCount = await redactChangeHistoryTable(client, 'capa_change_history');
      console.log(`[Redaction] capa_change_history: ${capaCount} rows updated`);
    } catch (e: any) {
      if (e.code === '42P01') {
        console.log('[Redaction] capa_change_history table does not exist — skipped');
      } else { throw e; }
    }

    let aiResult: AiPendingActionsSweepResult | null = null;
    let aiSkipReason: string | null = null;

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
      if (e.code === '42P01') {
        aiSkipReason = 'table_missing';
        console.log('[Redaction] ai_pending_actions table does not exist — skipped');
      } else { throw e; }
    }

    const total = elCount + ncCount + capaCount + aiCount;
    console.log(`[Redaction] Sweep complete. Total rows updated: ${total}`);

    // Emit an immutable audit-log entry recording that the sweep ran. This
    // is the cross-table receipt auditors look for after the historical
    // backfill (ISO 27001 A.5.34, PDPL Art. 16, PCI DSS v4.0 §10.2.1).
    // Failure to write the audit row must NOT mask the sweep result, so
    // any error is logged and swallowed.
    try {
      await logEvent({
        actionType: 'UPDATE',
        entityType: 'SYSTEM',
        entityId: 'ai_pending_actions',
        entityName: 'Historical secret-redaction sweep',
        description:
          `Backfilled redactSecretLikeStrings + redactSensitiveFields across ` +
          `historical audit tables. event_logs=${elCount}, ` +
          `nc_change_history=${ncCount}, capa_change_history=${capaCount}, ` +
          `ai_pending_actions=${aiCount} (rows updated).`,
        newValue: {
          sweep_timestamp: REDACT_DATE,
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
            : { skipped: aiSkipReason ?? 'unknown' },
          total_rows_updated: total,
        },
        aiInvolved: false,
        severity: 'INFO',
        module: 'security/redaction-sweep',
      });
      console.log('[Redaction] Audit-log entry emitted for sweep run');
    } catch (auditErr) {
      console.error('[Redaction] Failed to emit audit-log entry:', auditErr);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

// Only run the sweep when this file is invoked directly via `tsx` / `node`.
// When imported from a test or another module, `main()` must NOT auto-execute
// (it would open a real DB connection and try to logEvent against production).
const isDirectInvocation = (() => {
  try {
    const entry = process.argv[1] || '';
    return /redactHistoricalLogs(\.ts|\.js)?$/.test(entry);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch(err => {
    console.error('[Redaction] Fatal error:', err);
    process.exit(1);
  });
}
