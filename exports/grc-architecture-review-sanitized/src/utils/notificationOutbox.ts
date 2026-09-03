import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";
import { sendChatProviderNotification } from "./ChatProviderNotifications";

const outboxPool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export interface OutboxEntry {
  id: number;
  source: string;
  channel: "ChatProvider";
  destination: string;
  payload: {
    text: string;
    blocks?: any[];
  };
  dedupe_key: string | null;
  status: "pending" | "processing" | "sent" | "failed";
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: any;
}

export interface OutboxEnqueueInput {
  source: string;
  destination: string;
  text: string;
  blocks?: any[];
  dedupeKey?: string;
  metadata?: any;
  maxAttempts?: number;
}

let outboxInit: Promise<void> | null = null;

async function initNotificationOutboxTable(): Promise<void> {
  if (outboxInit) return outboxInit;
  outboxInit = (async () => {
    await outboxPool.query(`
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id SERIAL PRIMARY KEY,
        source VARCHAR(120) NOT NULL,
        channel VARCHAR(20) NOT NULL DEFAULT 'ChatProvider',
        destination VARCHAR(255) NOT NULL,
        payload JSONB NOT NULL,
        dedupe_key VARCHAR(255),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 4,
        last_error TEXT,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await outboxPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_outbox_dedupe
      ON notification_outbox(dedupe_key)
      WHERE dedupe_key IS NOT NULL;
    `);
    await outboxPool.query(`
      CREATE INDEX IF NOT EXISTS idx_notification_outbox_status_due
      ON notification_outbox(status, next_attempt_at);
    `);
  })().catch((err) => {
    outboxInit = null;
    throw err;
  });
  return outboxInit;
}

function retryDelaySeconds(attemptNumber: number): number {
  const base = Number.parseInt(process.env.NOTIFICATION_OUTBOX_RETRY_BASE_SECONDS || "60", 10);
  const safeBase = Number.isFinite(base) && base > 0 ? base : 60;
  const cappedAttempt = Math.min(Math.max(1, attemptNumber), 8);
  return safeBase * Math.pow(2, cappedAttempt - 1);
}

export async function enqueueChatProviderOutboxMessage(
  input: OutboxEnqueueInput,
): Promise<OutboxEntry> {
  await initNotificationOutboxTable();
  const maxAttempts =
    input.maxAttempts && input.maxAttempts > 0 ? Math.floor(input.maxAttempts) : 4;
  const payload = {
    text: input.text,
    blocks: Array.isArray(input.blocks) ? input.blocks : undefined,
  };
  const result = await outboxPool.query(
    `INSERT INTO notification_outbox
       (source, channel, destination, payload, dedupe_key, status, attempts, max_attempts, next_attempt_at, metadata)
     VALUES
       ($1, 'ChatProvider', $2, $3::jsonb, $4, 'pending', 0, $5, NOW(), $6::jsonb)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL
     DO UPDATE SET
       destination = EXCLUDED.destination,
       payload = EXCLUDED.payload,
       max_attempts = EXCLUDED.max_attempts,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [
      input.source,
      input.destination,
      JSON.stringify(payload),
      input.dedupeKey || null,
      maxAttempts,
      JSON.stringify(input.metadata || {}),
    ],
  );
  return result.rows[0] as OutboxEntry;
}

async function markOutboxSent(id: number, attempts: number): Promise<OutboxEntry> {
  const result = await outboxPool.query(
    `UPDATE notification_outbox
     SET status = 'sent',
         attempts = $2,
         last_error = NULL,
         sent_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, attempts],
  );
  return result.rows[0] as OutboxEntry;
}

async function markOutboxRetry(
  id: number,
  attempts: number,
  maxAttempts: number,
  errorText: string,
): Promise<OutboxEntry> {
  if (attempts >= maxAttempts) {
    const failed = await outboxPool.query(
      `UPDATE notification_outbox
       SET status = 'failed',
           attempts = $2,
           last_error = $3,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, attempts, errorText],
    );
    return failed.rows[0] as OutboxEntry;
  }

  const delay = retryDelaySeconds(attempts);
  const retry = await outboxPool.query(
    `UPDATE notification_outbox
     SET status = 'pending',
         attempts = $2,
         last_error = $3,
         next_attempt_at = NOW() + ($4::text || ' seconds')::interval,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, attempts, errorText, String(delay)],
  );
  return retry.rows[0] as OutboxEntry;
}

export async function processOutboxMessageById(id: number): Promise<OutboxEntry | null> {
  await initNotificationOutboxTable();
  const lock = await outboxPool.query(
    `UPDATE notification_outbox
     SET status = CASE WHEN status = 'pending' THEN 'processing' ELSE status END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id],
  );
  const row = lock.rows[0] as OutboxEntry | undefined;
  if (!row) return null;
  if (row.status === "sent" || row.status === "failed") return row;

  const payload = row.payload || { text: "" };
  try {
    const sent = await sendChatProviderNotification(
      row.destination,
      payload.text || "(empty message)",
      payload.blocks,
    );
    if (sent) {
      return await markOutboxSent(row.id, row.attempts + 1);
    }
    return await markOutboxRetry(
      row.id,
      row.attempts + 1,
      row.max_attempts,
      "ChatProvider helper returned false",
    );
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    return await markOutboxRetry(
      row.id,
      row.attempts + 1,
      row.max_attempts,
      errorText,
    );
  }
}

export async function processDueOutboxMessages(limit = 20): Promise<{
  scanned: number;
  sent: number;
  pending: number;
  failed: number;
}> {
  await initNotificationOutboxTable();
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 200) : 20;
  const due = await outboxPool.query(
    `SELECT id
     FROM notification_outbox
     WHERE status = 'pending' AND next_attempt_at <= NOW()
     ORDER BY created_at ASC
     LIMIT $1`,
    [safeLimit],
  );
  let sent = 0;
  let pending = 0;
  let failed = 0;
  for (const row of due.rows) {
    const processed = await processOutboxMessageById(Number(row.id));
    if (!processed) continue;
    if (processed.status === "sent") sent += 1;
    else if (processed.status === "failed") failed += 1;
    else pending += 1;
  }
  logger.info("[Outbox] Processed due messages", {
    scanned: due.rows.length,
    sent,
    pending,
    failed,
  });
  return { scanned: due.rows.length, sent, pending, failed };
}

export async function getOutboxEntries(params?: {
  source?: string;
  status?: "pending" | "processing" | "sent" | "failed";
  limit?: number;
}): Promise<OutboxEntry[]> {
  await initNotificationOutboxTable();
  const limit = params?.limit && params.limit > 0 ? Math.min(params.limit, 200) : 50;
  const where: string[] = [];
  const values: any[] = [];
  let i = 1;
  if (params?.source) {
    where.push(`source = $${i++}`);
    values.push(params.source);
  }
  if (params?.status) {
    where.push(`status = $${i++}`);
    values.push(params.status);
  }
  values.push(limit);
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const result = await outboxPool.query(
    `SELECT *
     FROM notification_outbox
     ${whereSql}
     ORDER BY created_at DESC
     LIMIT $${i}`,
    values,
  );
  return result.rows as OutboxEntry[];
}
