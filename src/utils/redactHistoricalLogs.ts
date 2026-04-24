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
import { redactSensitiveFields, isSensitiveField, REDACTED_SENTINEL } from './eventLogsDatabase';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const REDACT_DATE = new Date().toISOString();
const BREADCRUMB_KEY = '_redacted_at';

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

async function redactAiPendingActions(client: any): Promise<number> {
  const rows = await client.query(
    `SELECT id, payload, execution_result FROM ai_pending_actions WHERE payload IS NOT NULL`
  );

  let updated = 0;
  for (const row of rows.rows) {
    let payload = row.payload;
    let execResult = row.execution_result;
    let changed = false;

    if (payload !== null) {
      const redacted = redactSensitiveFields(payload);
      if (JSON.stringify(redacted) !== JSON.stringify(payload)) {
        payload = redacted;
        changed = true;
      }
    }

    if (execResult !== null) {
      const redacted = redactSensitiveFields(execResult);
      if (JSON.stringify(redacted) !== JSON.stringify(execResult)) {
        execResult = redacted;
        changed = true;
      }
    }

    if (changed) {
      await client.query(
        `UPDATE ai_pending_actions SET payload = $1, execution_result = $2 WHERE id = $3`,
        [
          payload !== null ? JSON.stringify(payload) : null,
          execResult !== null ? JSON.stringify(execResult) : null,
          row.id,
        ]
      );
      updated++;
    }
  }
  return updated;
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

    try {
      aiCount = await redactAiPendingActions(client);
      console.log(`[Redaction] ai_pending_actions: ${aiCount} rows updated`);
    } catch (e: any) {
      if (e.code === '42P01') {
        console.log('[Redaction] ai_pending_actions table does not exist — skipped');
      } else { throw e; }
    }

    const total = elCount + ncCount + capaCount + aiCount;
    console.log(`[Redaction] Sweep complete. Total rows updated: ${total}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('[Redaction] Fatal error:', err);
  process.exit(1);
});
